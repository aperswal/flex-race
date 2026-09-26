// `start_by`: the instant by which OpenAI's flex tier must have admitted the request. It is the only
// input this library adds to a Responses call, and it accepts exactly one shape: an ISO 8601 date-time
// with seconds and an explicit timezone (`Z` or `+hh:mm` / `-hh:mm`). A string without a timezone means
// different instants on different servers, and a Date or a bare number invites "30 means 30 seconds",
// so both are refused rather than guessed at.

export interface Deadline {
  // Milliseconds the flex attempt may wait for admission, measured from the local clock at call time.
  // Negative when start_by is already in the past.
  readonly msLeft: number;
  // True when start_by lay beyond MAX_WINDOW_MS and the wait was cut to it.
  readonly capped: boolean;
}

// Less time than this is not worth a flex attempt: the request goes straight to the default tier.
export const MIN_LEAD_MS = 5_000;
// The longest a flex attempt waits for admission, however far away start_by is.
export const MAX_WINDOW_MS = 600_000;

export class StartByError extends Error {
  override readonly name = "StartByError";
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

// Parse start_by and measure it against `nowMs`. Throws StartByError on anything that is not a valid,
// timezone-qualified ISO 8601 date-time.
export function parseStartBy(value: unknown, nowMs: number): Deadline {
  const targetMs = instantOf(value);
  const msLeft = targetMs - nowMs;
  if (msLeft > MAX_WINDOW_MS) return { msLeft: MAX_WINDOW_MS, capped: true };
  return { msLeft, capped: false };
}

function instantOf(value: unknown): number {
  if (typeof value !== "string") {
    throw new StartByError(
      `start_by must be an ISO 8601 string with a timezone, such as "2026-09-25T18:00:00Z"; got ${describe(value)}`,
    );
  }
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) {
    throw new StartByError(
      `start_by must be an ISO 8601 date-time with seconds and a timezone ("Z" or "+hh:mm"), such as ` +
        `"2026-09-25T18:00:00Z"; got ${JSON.stringify(value)}`,
    );
  }
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, offH, offM] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));

  const utcOfFields = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const roundTrip = new Date(utcOfFields);
  const fieldsValid =
    hour < 24 &&
    minute < 60 &&
    second < 60 &&
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day;
  if (!fieldsValid) throw new StartByError(`start_by is not a real date and time: ${JSON.stringify(value)}`);

  if (zulu !== undefined) return utcOfFields;
  const offsetHours = Number(offH);
  const offsetMinutes = Number(offM);
  if (offsetHours > 23 || offsetMinutes > 59) {
    throw new StartByError(`start_by has an impossible timezone offset: ${JSON.stringify(value)}`);
  }
  const offsetMs = (offsetHours * 60 + offsetMinutes) * 60_000;
  // A local time at +05:00 is five hours AHEAD of UTC, so the UTC instant is the fields minus the offset.
  return sign === "+" ? utcOfFields - offsetMs : utcOfFields + offsetMs;
}

function describe(value: unknown): string {
  if (value instanceof Date) return "a Date object";
  if (value === null) return "null";
  return typeof value;
}
