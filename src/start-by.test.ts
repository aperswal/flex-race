import { describe, expect, it } from "vitest";

import { MAX_WINDOW_MS, StartByError, parseStartBy } from "./start-by.js";

const NOW = Date.UTC(2026, 8, 25, 18, 0, 0); // 2026-09-25T18:00:00Z

describe("parseStartBy accepts a timezone-qualified ISO 8601 date-time", () => {
  it("reads a UTC instant", () => {
    expect(parseStartBy("2026-09-25T18:00:30Z", NOW)).toEqual({ msLeft: 30_000, capped: false });
  });

  it("applies a positive offset: 23:00 at +05:00 is 18:00 UTC", () => {
    expect(parseStartBy("2026-09-25T23:00:30+05:00", NOW).msLeft).toBe(30_000);
  });

  it("applies a negative offset: 13:00 at -05:00 is 18:00 UTC", () => {
    expect(parseStartBy("2026-09-25T13:00:30-05:00", NOW).msLeft).toBe(30_000);
  });

  it("applies a half-hour offset", () => {
    expect(parseStartBy("2026-09-25T23:30:30+05:30", NOW).msLeft).toBe(30_000);
  });

  it("keeps milliseconds and truncates finer fractions", () => {
    expect(parseStartBy("2026-09-25T18:00:30.250Z", NOW).msLeft).toBe(30_250);
    expect(parseStartBy("2026-09-25T18:00:30.5Z", NOW).msLeft).toBe(30_500);
    expect(parseStartBy("2026-09-25T18:00:30.123456789Z", NOW).msLeft).toBe(30_123);
  });

  it("returns a negative wait for an instant in the past", () => {
    expect(parseStartBy("2026-09-25T17:59:00Z", NOW).msLeft).toBe(-60_000);
  });

  it("crosses a day boundary through the offset", () => {
    expect(parseStartBy("2026-09-26T03:00:30+09:00", NOW).msLeft).toBe(30_000);
  });
});

describe("parseStartBy caps a far-off start_by at the maximum window", () => {
  it("leaves exactly the maximum uncapped", () => {
    expect(parseStartBy("2026-09-25T18:10:00Z", NOW)).toEqual({ msLeft: MAX_WINDOW_MS, capped: false });
  });

  it("caps one millisecond beyond it, and says so", () => {
    expect(parseStartBy("2026-09-25T18:10:00.001Z", NOW)).toEqual({ msLeft: MAX_WINDOW_MS, capped: true });
  });

  it("caps an instant hours away", () => {
    expect(parseStartBy("2026-09-26T18:00:00Z", NOW)).toEqual({ msLeft: MAX_WINDOW_MS, capped: true });
  });
});

describe("parseStartBy refuses everything else", () => {
  const rejected: readonly [string, unknown][] = [
    ["a string with no timezone", "2026-09-25T18:00:30"],
    ["a date with no time", "2026-09-25"],
    ["a time without seconds", "2026-09-25T18:00Z"],
    ["a space instead of T", "2026-09-25 18:00:30Z"],
    ["a lowercase z", "2026-09-25T18:00:30z"],
    ["an offset without a colon", "2026-09-25T18:00:30+0500"],
    ["an empty string", ""],
    ["surrounding whitespace", " 2026-09-25T18:00:30Z "],
    ["February 30th", "2026-02-30T18:00:30Z"],
    ["hour 24", "2026-09-25T24:00:00Z"],
    ["minute 60", "2026-09-25T18:60:00Z"],
    ["second 60", "2026-09-25T18:00:60Z"],
    ["month 13", "2026-13-01T18:00:00Z"],
    ["an offset of 24 hours", "2026-09-25T18:00:30+24:00"],
    ["a Date object", new Date(NOW)],
    ["a number of milliseconds", NOW],
    ["a number of seconds", 30],
    ["null", null],
    ["undefined", undefined],
  ];

  for (const [label, value] of rejected) {
    it(`refuses ${label}`, () => {
      expect(() => parseStartBy(value, NOW)).toThrow(StartByError);
    });
  }

  it("names the Date case in the message, since it is the likeliest mistake", () => {
    expect(() => parseStartBy(new Date(NOW), NOW)).toThrow(/a Date object/);
  });

  it("accepts February 29th in a leap year", () => {
    expect(() => parseStartBy("2028-02-29T00:00:00Z", NOW)).not.toThrow();
  });
});
