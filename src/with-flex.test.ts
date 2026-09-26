import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_WINDOW_MS, StartByError } from "./start-by.js";
import { withFlex, type FlexOutcome } from "./with-flex.js";

// A stand-in for the OpenAI client. `serve` decides what each responses.create call returns, and every
// call is recorded with the body and request options it was made with.
interface Call {
  readonly body: Record<string, unknown>;
  readonly options: { signal?: AbortSignal; maxRetries?: number } | undefined;
}
type Serve = (call: Call, index: number) => Promise<unknown>;

function fakeClient(serve: Serve): { client: OpenAI; calls: Call[] } {
  const calls: Call[] = [];
  const responses = {
    create: (body: Record<string, unknown>, options?: Call["options"]) => {
      const call = { body, options };
      calls.push(call);
      return serve(call, calls.length - 1);
    },
    retrieve: (id: string) => `retrieved ${id}`,
  };
  const client = { responses, models: { list: () => "models" } } as unknown as OpenAI;
  return { client, calls };
}

type Event = Record<string, unknown> & { type: string };

const RESPONSE = { id: "resp_flex", status: "completed", output: [] };
const DEFAULT_RESPONSE = { id: "resp_default", status: "completed", output: [] };
const CREATED: Event = { type: "response.created", response: { id: "resp_flex" } };
const ADMITTED: Event = { type: "response.in_progress", response: { id: "resp_flex" } };
const DELTA: Event = { type: "response.output_text.delta", delta: "hi" };
const COMPLETED: Event = { type: "response.completed", response: RESPONSE };
const FAILED: Event = {
  type: "response.failed",
  response: { id: "resp_flex", error: { code: "server_error" } },
};

// An event stream that yields `events`, then either ends or, with `hang`, waits until aborted.
function streamOf(
  events: readonly Event[],
  signal: AbortSignal | undefined,
  hang = false,
): AsyncIterable<Event> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        await Promise.resolve();
        yield event;
      }
      if (hang) await abortedPromise(signal);
    },
  };
}

function abortedPromise(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  });
}

function apiError(status: number, type: string): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { status, type });
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const NOW = Date.UTC(2026, 8, 25, 18, 0, 0);
const IN_30S = "2026-09-25T18:00:30Z";

let outcomes: FlexOutcome[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  outcomes = [];
});
afterEach(() => {
  vi.useRealTimers();
});

function wrap(client: OpenAI): ReturnType<typeof withFlex> {
  return withFlex(client, { onOutcome: (o) => outcomes.push(o) });
}

describe("without start_by", () => {
  it("passes the call through untouched and reports nothing", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(DEFAULT_RESPONSE));
    const result = await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi" });
    expect(result).toBe(DEFAULT_RESPONSE);
    expect(calls).toEqual([{ body: { model: "gpt-6-sol", input: "hi" }, options: undefined }]);
    expect(outcomes).toEqual([]);
  });

  it("leaves every other client and responses member reachable", () => {
    const { client } = fakeClient(() => Promise.resolve(DEFAULT_RESPONSE));
    const flexClient = wrap(client) as unknown as {
      models: { list: () => string };
      responses: { retrieve: (id: string) => string };
    };
    expect(flexClient.models.list()).toBe("models");
    expect(flexClient.responses.retrieve("resp_1")).toBe("retrieved resp_1");
  });
});

describe("refusing bad input before any request", () => {
  it("refuses start_by together with service_tier", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(DEFAULT_RESPONSE));
    await expect(
      wrap(client).responses.create({
        model: "gpt-6-sol",
        input: "hi",
        start_by: IN_30S,
        service_tier: "priority",
      }),
    ).rejects.toThrow(StartByError);
    expect(calls).toEqual([]);
  });

  it("refuses a start_by that is not a timezone-qualified ISO string", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(DEFAULT_RESPONSE));
    await expect(
      wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: "2026-09-25T18:00:30" }),
    ).rejects.toThrow(StartByError);
    expect(calls).toEqual([]);
  });
});

describe("a start_by too near to race", () => {
  it("goes straight to the default tier when under five seconds remain", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(DEFAULT_RESPONSE));
    const result = await wrap(client).responses.create({
      model: "gpt-6-sol",
      input: "hi",
      start_by: "2026-09-25T18:00:04.999Z",
    });
    expect(result).toBe(DEFAULT_RESPONSE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ model: "gpt-6-sol", input: "hi", service_tier: "default" });
    expect(outcomes).toEqual([{ tier: "default", reason: "deadline_too_near", waitedMs: 0, capped: false }]);
  });

  it("does the same for a start_by already in the past", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(DEFAULT_RESPONSE));
    await wrap(client).responses.create({
      model: "gpt-6-sol",
      input: "hi",
      start_by: "2026-09-25T17:00:00Z",
    });
    expect(calls.map((c) => c.body["service_tier"])).toEqual(["default"]);
    expect(outcomes[0]?.reason).toBe("deadline_too_near");
  });
});

describe("flex admits the request in time", () => {
  it("returns the flex response to a non-streaming caller", async () => {
    const { client, calls } = fakeClient(({ options }) =>
      Promise.resolve(streamOf([CREATED, ADMITTED, DELTA, COMPLETED], options?.signal)),
    );
    const result = await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S });
    expect(result).toBe(RESPONSE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ model: "gpt-6-sol", input: "hi", stream: true, service_tier: "flex" });
    expect(calls[0]?.options?.maxRetries).toBe(0);
    expect(outcomes).toEqual([{ tier: "flex", reason: "admitted", waitedMs: 0, capped: false }]);
  });

  it("streams every flex event to a streaming caller, the buffered head first", async () => {
    const { client } = fakeClient(({ options }) =>
      Promise.resolve(streamOf([CREATED, ADMITTED, DELTA, COMPLETED], options?.signal)),
    );
    const stream = await wrap(client).responses.create({
      model: "gpt-6-sol",
      input: "hi",
      stream: true,
      start_by: IN_30S,
    });
    expect(await collect(stream)).toEqual([CREATED, ADMITTED, DELTA, COMPLETED]);
    expect(outcomes[0]).toMatchObject({ tier: "flex", reason: "admitted" });
  });

  it("returns the flex response when the admitting event is already the final one", async () => {
    const { client, calls } = fakeClient(({ options }) =>
      Promise.resolve(streamOf([CREATED, ADMITTED, COMPLETED], options?.signal)),
    );
    const result = await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S });
    expect(result).toBe(RESPONSE);
    expect(calls).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ tier: "flex", reason: "admitted" });
  });

  it("reports a capped window when start_by is beyond ten minutes", async () => {
    const { client } = fakeClient(({ options }) =>
      Promise.resolve(streamOf([CREATED, ADMITTED, COMPLETED], options?.signal)),
    );
    await wrap(client).responses.create({
      model: "gpt-6-sol",
      input: "hi",
      start_by: "2026-09-26T00:00:00Z",
    });
    expect(outcomes[0]).toMatchObject({ tier: "flex", capped: true });
  });
});

describe("start_by passes before flex admits the request", () => {
  it("aborts flex and runs the default tier when the queue outlasts the deadline", async () => {
    let flexSignal: AbortSignal | undefined;
    const { client, calls } = fakeClient(({ options }, index) => {
      if (index > 0) return Promise.resolve(DEFAULT_RESPONSE);
      flexSignal = options?.signal;
      return Promise.resolve(streamOf([CREATED], options?.signal, true));
    });
    const pending = wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(DEFAULT_RESPONSE);
    expect(flexSignal?.aborted).toBe(true);
    expect(calls[1]?.body).toEqual({ model: "gpt-6-sol", input: "hi", service_tier: "default" });
    expect(outcomes).toEqual([
      { tier: "default", reason: "deadline_elapsed", waitedMs: 30_000, capped: false },
    ]);
  });

  it("counts a slow connection against the deadline too", async () => {
    const { client } = fakeClient(({ options }, index) =>
      index > 0 ? Promise.resolve(DEFAULT_RESPONSE) : abortedPromise(options?.signal),
    );
    const pending = wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(DEFAULT_RESPONSE);
    expect(outcomes[0]?.reason).toBe("deadline_elapsed");
  });

  it("hands a streaming caller the default tier's stream", async () => {
    const defaultStream = streamOf([DELTA], undefined);
    const { client, calls } = fakeClient(({ options }, index) =>
      Promise.resolve(index > 0 ? defaultStream : streamOf([CREATED], options?.signal, true)),
    );
    const pending = wrap(client).responses.create({
      model: "gpt-6-sol",
      input: "hi",
      stream: true,
      start_by: IN_30S,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(defaultStream);
    expect(calls[1]?.body).toEqual({
      model: "gpt-6-sol",
      input: "hi",
      stream: true,
      service_tier: "default",
    });
  });
});

describe("flex refuses the request before admission", () => {
  it("falls back when opening the flex request throws, including a 400 on a model with no flex tier", async () => {
    const { client, calls } = fakeClient((_, index) =>
      index > 0 ? Promise.resolve(DEFAULT_RESPONSE) : Promise.reject(apiError(400, "invalid_request_error")),
    );
    const result = await wrap(client).responses.create({ model: "gpt-4o", input: "hi", start_by: IN_30S });
    expect(result).toBe(DEFAULT_RESPONSE);
    expect(calls.map((c) => c.body["service_tier"])).toEqual(["flex", "default"]);
    expect(outcomes[0]).toMatchObject({ tier: "default", reason: "flex_refused" });
  });

  it("falls back when an error follows response.in_progress, as on a model with no flex tier", async () => {
    const { client, calls } = fakeClient((_, index) =>
      Promise.resolve(
        index > 0
          ? DEFAULT_RESPONSE
          : {
              async *[Symbol.asyncIterator]() {
                await Promise.resolve();
                yield CREATED;
                yield ADMITTED;
                throw apiError(400, "invalid_request_error");
              },
            },
      ),
    );
    const result = await wrap(client).responses.create({ model: "gpt-4o", input: "hi", start_by: IN_30S });
    expect(result).toBe(DEFAULT_RESPONSE);
    expect(calls.map((c) => c.body["service_tier"])).toEqual(["flex", "default"]);
    expect(outcomes[0]).toMatchObject({ tier: "default", reason: "flex_refused" });
  });

  it("falls back when response.failed follows response.in_progress", async () => {
    const { client } = fakeClient(({ options }, index) =>
      Promise.resolve(index > 0 ? DEFAULT_RESPONSE : streamOf([CREATED, ADMITTED, FAILED], options?.signal)),
    );
    expect(await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S })).toBe(
      DEFAULT_RESPONSE,
    );
    expect(outcomes[0]?.reason).toBe("flex_refused");
  });

  it("falls back when the stream ends right after response.in_progress", async () => {
    const { client } = fakeClient(({ options }, index) =>
      Promise.resolve(index > 0 ? DEFAULT_RESPONSE : streamOf([CREATED, ADMITTED], options?.signal)),
    );
    expect(await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S })).toBe(
      DEFAULT_RESPONSE,
    );
    expect(outcomes[0]?.reason).toBe("flex_refused");
  });

  it("falls back on a response.failed event before admission", async () => {
    const { client } = fakeClient(({ options }, index) =>
      Promise.resolve(index > 0 ? DEFAULT_RESPONSE : streamOf([CREATED, FAILED], options?.signal)),
    );
    expect(await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S })).toBe(
      DEFAULT_RESPONSE,
    );
    expect(outcomes[0]?.reason).toBe("flex_refused");
  });

  it("falls back when the flex stream ends before admission", async () => {
    const { client } = fakeClient(({ options }, index) =>
      Promise.resolve(index > 0 ? DEFAULT_RESPONSE : streamOf([CREATED], options?.signal)),
    );
    expect(await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S })).toBe(
      DEFAULT_RESPONSE,
    );
    expect(outcomes[0]?.reason).toBe("flex_refused");
  });

  it("passes the default tier's own error through when it fails too", async () => {
    const defaultError = apiError(401, "invalid_request_error");
    const { client } = fakeClient((_, index) =>
      Promise.reject(index > 0 ? defaultError : apiError(401, "invalid_request_error")),
    );
    await expect(
      wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S }),
    ).rejects.toBe(defaultError);
  });
});

describe("flex fails after admitting a non-streaming request", () => {
  it("re-runs a transient failure on the default tier", async () => {
    const { client, calls } = fakeClient(({ options }, index) =>
      Promise.resolve(
        index > 0 ? DEFAULT_RESPONSE : streamOf([CREATED, ADMITTED, DELTA, FAILED], options?.signal),
      ),
    );
    expect(await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S })).toBe(
      DEFAULT_RESPONSE,
    );
    expect(calls).toHaveLength(2);
    expect(outcomes).toEqual([
      { tier: "default", reason: "flex_failed_after_admission", waitedMs: 0, capped: false },
    ]);
  });

  it("re-runs when the stream ends with no final response", async () => {
    const { client } = fakeClient(({ options }, index) =>
      Promise.resolve(index > 0 ? DEFAULT_RESPONSE : streamOf([CREATED, ADMITTED, DELTA], options?.signal)),
    );
    expect(await wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S })).toBe(
      DEFAULT_RESPONSE,
    );
  });

  it("throws an invalid-request error instead of re-running it, since it fails on every tier", async () => {
    const invalid = apiError(400, "invalid_request_error");
    const { client, calls } = fakeClient(() =>
      Promise.resolve({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield CREATED;
          yield ADMITTED;
          yield DELTA;
          throw invalid;
        },
      }),
    );
    await expect(
      wrap(client).responses.create({ model: "gpt-6-sol", input: "hi", start_by: IN_30S }),
    ).rejects.toBe(invalid);
    expect(calls).toHaveLength(1);
  });
});

describe("the caller aborting", () => {
  it("throws the caller's abort instead of falling back", async () => {
    const controller = new AbortController();
    const { client, calls } = fakeClient(({ options }) =>
      Promise.resolve(streamOf([CREATED], options?.signal, true)),
    );
    const pending = wrap(client).responses.create(
      { model: "gpt-6-sol", input: "hi", start_by: IN_30S },
      { signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
    expect(calls).toHaveLength(1);
    expect(outcomes).toEqual([]);
  });

  it("aborts the flex request with the caller's signal", async () => {
    const controller = new AbortController();
    let flexSignal: AbortSignal | undefined;
    const { client } = fakeClient(({ options }) => {
      flexSignal = options?.signal;
      return Promise.resolve(streamOf([CREATED], options?.signal, true));
    });
    const pending = wrap(client).responses.create(
      { model: "gpt-6-sol", input: "hi", start_by: IN_30S },
      { signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await pending.catch(() => undefined);
    expect(flexSignal?.aborted).toBe(true);
  });
});

describe("the window cap", () => {
  it("gives up at ten minutes even when start_by is later", async () => {
    const { client } = fakeClient(({ options }, index) =>
      Promise.resolve(index > 0 ? DEFAULT_RESPONSE : streamOf([CREATED], options?.signal, true)),
    );
    const pending = wrap(client).responses.create({
      model: "gpt-6-sol",
      input: "hi",
      start_by: "2026-09-25T20:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(MAX_WINDOW_MS);
    expect(await pending).toBe(DEFAULT_RESPONSE);
    expect(outcomes).toEqual([
      { tier: "default", reason: "deadline_elapsed", waitedMs: MAX_WINDOW_MS, capped: true },
    ]);
  });
});
