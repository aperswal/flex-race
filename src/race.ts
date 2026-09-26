// Wait for the flex attempt to be admitted, or give up on it.
//
// OpenAI streams `response.created` as soon as it accepts a flex request, then `response.in_progress`
// once flex capacity picks the request up. `response.in_progress` alone is not proof of admission: on a
// model with no flex tier (gpt-4o, seen live on 2026-09-26) OpenAI sends it and then an
// `invalid_request_error` straight after. So the request counts as admitted at the first event AFTER
// `response.in_progress` that is not a failure. On a real admission that event follows at once and
// still comes before the first output token, so the deadline measures time to admission, not time to
// first token.

export const IN_PROGRESS_EVENT = "response.in_progress";

export type RaceResult<Event> =
  // Flex admitted the request. `buffered` holds every event read so far, the admitting event included,
  // so the caller can replay them before `rest`, the same iterator positioned just after admission.
  | { readonly kind: "admitted"; readonly buffered: readonly Event[]; readonly rest: AsyncIterator<Event> }
  // The deadline passed first.
  | { readonly kind: "elapsed" }
  // Flex refused or failed before admission: an error thrown while opening or reading the stream
  // (including one right after `response.in_progress`), a `response.failed` event, or the stream
  // ending early.
  | { readonly kind: "refused"; readonly cause: unknown };

interface TypedEvent {
  readonly type: string;
}

const ELAPSED = Symbol("elapsed");

// `open` starts the flex request. It runs inside the deadline, so a slow connection counts against
// start_by the same way a slow queue does.
export async function raceForAdmission<Event extends TypedEvent>(
  open: () => Promise<AsyncIterable<Event>>,
  msLeft: number,
): Promise<RaceResult<Event>> {
  const timer = deadline(msLeft);
  try {
    const opened = open();
    const stream = await Promise.race([opened, timer.elapsed]);
    if (stream === ELAPSED) {
      opened.catch(() => undefined); // the caller aborts it; swallow the rejection that follows
      return { kind: "elapsed" };
    }
    const iterator = stream[Symbol.asyncIterator]();
    const buffered: Event[] = [];
    let inProgress = false;
    for (;;) {
      const next = iterator.next();
      const step = await Promise.race([next, timer.elapsed]);
      if (step === ELAPSED) {
        next.catch(() => undefined);
        return { kind: "elapsed" };
      }
      if (step.done === true) {
        return { kind: "refused", cause: new Error("flex stream ended before admission") };
      }
      buffered.push(step.value);
      if (step.value.type === "response.failed") return { kind: "refused", cause: step.value };
      if (inProgress) return { kind: "admitted", buffered, rest: iterator };
      if (step.value.type === IN_PROGRESS_EVENT) inProgress = true;
    }
  } catch (cause) {
    return { kind: "refused", cause };
  } finally {
    timer.cancel();
  }
}

function deadline(ms: number): { elapsed: Promise<typeof ELAPSED>; cancel: () => void } {
  let id: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<typeof ELAPSED>((resolve) => {
    id = setTimeout(
      () => {
        resolve(ELAPSED);
      },
      Math.max(0, ms),
    );
  });
  return {
    elapsed,
    cancel: () => {
      clearTimeout(id);
    },
  };
}
