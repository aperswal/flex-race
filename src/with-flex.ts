// withFlex wraps an OpenAI client so `responses.create` accepts one extra field, `start_by`. With it,
// the request first goes to OpenAI's flex tier (roughly half the price) and waits for flex to admit it.
// If flex admits it by start_by, the caller gets the flex response. If start_by passes first, or flex
// refuses or fails before admitting it, the flex attempt is aborted and the request runs on the default
// tier instead. Without start_by the call passes through untouched.
//
// There is no model list: any model is tried on flex, and a model OpenAI will not serve on flex simply
// falls back. The cost is one extra round trip on such models, and only when start_by is set.

import type OpenAI from "openai";
import { Stream } from "openai/streaming";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import { raceForAdmission } from "./race.js";
import { MIN_LEAD_MS, StartByError, parseStartBy } from "./start-by.js";

export type FlexReason =
  // Flex admitted the request before start_by.
  | "admitted"
  // start_by was less than MIN_LEAD_MS away, or already past: flex was not attempted.
  | "deadline_too_near"
  // start_by passed while waiting for flex to admit the request.
  | "deadline_elapsed"
  // Flex refused or failed before admitting the request (an HTTP error, a failed response, a model
  // with no flex tier).
  | "flex_refused"
  // Flex admitted a non-streaming request, then the response failed transiently, so it was re-run on
  // the default tier. A streaming caller has already received flex events and sees the failure instead.
  | "flex_failed_after_admission";

export interface FlexOutcome {
  readonly tier: "flex" | "default";
  readonly reason: FlexReason;
  // Milliseconds from the call to the moment the tier was decided.
  readonly waitedMs: number;
  // True when start_by was more than MAX_WINDOW_MS away and the wait was cut to it.
  readonly capped: boolean;
}

export interface WithFlexOptions {
  // Called once per call that carries start_by, when the serving tier is decided.
  readonly onOutcome?: (outcome: FlexOutcome) => void;
  // The clock start_by is measured against. Defaults to Date.now.
  readonly now?: () => number;
}

type RequestOptions = NonNullable<Parameters<OpenAI["responses"]["create"]>[1]>;

export type WithStartBy<Params> = Params & {
  // ISO 8601 date-time with seconds and a timezone, such as "2026-09-25T18:00:00Z".
  readonly start_by?: string;
};

export interface FlexResponses {
  create(body: WithStartBy<ResponseCreateParamsNonStreaming>, options?: RequestOptions): Promise<Response>;
  create(
    body: WithStartBy<ResponseCreateParamsStreaming>,
    options?: RequestOptions,
  ): Promise<Stream<ResponseStreamEvent>>;
}

export type FlexClient = Omit<OpenAI, "responses"> & {
  readonly responses: Omit<OpenAI["responses"], "create"> & FlexResponses;
};

type AnyParams = WithStartBy<ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming>;
type CreateResult = Response | Stream<ResponseStreamEvent>;
type RawCreate = (body: object, options?: RequestOptions) => Promise<CreateResult>;

export function withFlex(client: OpenAI, options: WithFlexOptions = {}): FlexClient {
  const responses = client.responses;
  const rawCreate = responses.create.bind(responses) as unknown as RawCreate;
  const create = makeCreate(rawCreate, options);
  const flexResponses = new Proxy(responses, {
    get(target, property, receiver) {
      if (property === "create") return create;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "responses") return flexResponses;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function makeCreate(rawCreate: RawCreate, options: WithFlexOptions): FlexResponses["create"] {
  const now = options.now ?? Date.now;
  const report = (outcome: FlexOutcome): void => options.onOutcome?.(outcome);

  async function create(body: AnyParams, requestOptions?: RequestOptions): Promise<CreateResult> {
    const { start_by: startBy, ...params } = body;
    if (startBy === undefined) return rawCreate(params, requestOptions);
    if (params.service_tier !== undefined && params.service_tier !== null) {
      throw new StartByError("start_by chooses the service tier; do not also pass service_tier");
    }

    const startedAt = now();
    const { msLeft, capped } = parseStartBy(startBy, startedAt);
    const decided = (tier: FlexOutcome["tier"], reason: FlexReason): void => {
      report({ tier, reason, waitedMs: now() - startedAt, capped });
    };
    const runDefault = (): Promise<CreateResult> =>
      rawCreate({ ...params, service_tier: "default" }, requestOptions);

    if (msLeft < MIN_LEAD_MS) {
      decided("default", "deadline_too_near");
      return runDefault();
    }

    const callerSignal = requestOptions?.signal ?? undefined;
    const flex = linkedController(callerSignal);
    const flexOptions: RequestOptions = { ...requestOptions, signal: flex.signal, maxRetries: 0 };
    const result = await raceForAdmission(
      () =>
        rawCreate({ ...params, stream: true, service_tier: "flex" }, flexOptions) as Promise<
          Stream<ResponseStreamEvent>
        >,
      msLeft,
    );

    if (result.kind !== "admitted") {
      flex.abort();
      if (callerSignal?.aborted === true) throw callerAbort(callerSignal);
      decided("default", result.kind === "elapsed" ? "deadline_elapsed" : "flex_refused");
      return runDefault();
    }

    if (params.stream === true) {
      decided("flex", "admitted");
      return new Stream(() => replay(result.buffered, result.rest), flex);
    }

    // The admitting event can itself be the final one, so the buffered head is read too.
    const final = await finalResponseOf(replay(result.buffered, result.rest), callerSignal);
    if (final.kind === "response") {
      decided("flex", "admitted");
      return final.response;
    }
    flex.abort();
    if (!final.retryable) throw final.cause;
    decided("default", "flex_failed_after_admission");
    return runDefault();
  }

  return create as FlexResponses["create"];
}

type Final =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "failed"; readonly cause: unknown; readonly retryable: boolean };

// Drain an admitted flex stream for a non-streaming caller and keep only the finished response.
async function finalResponseOf(
  rest: AsyncIterator<ResponseStreamEvent>,
  callerSignal: AbortSignal | undefined,
): Promise<Final> {
  try {
    for (;;) {
      const step = await rest.next();
      if (step.done === true) {
        return {
          kind: "failed",
          cause: new Error("flex stream ended without a final response"),
          retryable: true,
        };
      }
      const event = step.value;
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        return { kind: "response", response: event.response };
      }
      // A failed flex response after admission is a capacity or server fault on OpenAI's side; the
      // same request can still succeed on the default tier.
      if (event.type === "response.failed") return { kind: "failed", cause: event, retryable: true };
    }
  } catch (cause) {
    if (callerSignal?.aborted === true) throw cause;
    return { kind: "failed", cause, retryable: !isInvalidRequest(cause) };
  }
}

// An invalid request fails the same way on every tier, so it is thrown rather than re-run.
function isInvalidRequest(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const type = (error as { type?: unknown }).type;
  return type === "invalid_request_error";
}

async function* replay<Event>(buffered: readonly Event[], rest: AsyncIterator<Event>): AsyncGenerator<Event> {
  yield* buffered;
  for (;;) {
    const step = await rest.next();
    if (step.done === true) return;
    yield step.value;
  }
}

function linkedController(parent: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (parent === undefined) return controller;
  if (parent.aborted) controller.abort(parent.reason);
  else {
    parent.addEventListener(
      "abort",
      () => {
        controller.abort(parent.reason);
      },
      { once: true },
    );
  }
  return controller;
}

function callerAbort(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("request aborted by caller");
}
