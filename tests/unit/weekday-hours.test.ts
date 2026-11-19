/**
 * The clock of the shop reminders (Sarah, CDS, 2026-11-19): only weekdays count. Saturday and
 * Sunday, in Pacific time (from Saturday 00:00 to Monday 00:00 in Los Angeles), are skipped.
 */
import { describe, expect, it } from "vitest";
import { addWeekdayHours, weekdayHours } from "@/lib/weekday-hours";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("weekdayHours", () => {
  it("counts plain hours within a weekday", () => {
    // Tue 2026-11-17 08:00 to 20:00 PT (PST, UTC-8).
    expect(weekdayHours(at("2026-11-17T16:00:00Z"), at("2026-11-18T04:00:00Z"))).toBe(12);
  });

  it("skips the weekend from Friday evening to Monday", () => {
    // Fri 2026-11-20 18:00 PT to Mon 2026-11-23 18:00 PT: 6 hours on Friday, 18 on Monday.
    expect(weekdayHours(at("2026-11-21T02:00:00Z"), at("2026-11-24T02:00:00Z"))).toBe(24);
  });

  it("counts nothing that starts and ends inside one weekend", () => {
    // Sat 2026-11-21 09:00 PT to Sun 2026-11-22 23:00 PT.
    expect(weekdayHours(at("2026-11-21T17:00:00Z"), at("2026-11-23T07:00:00Z"))).toBe(0);
  });

  it("starts counting on Monday 00:00 PT when the clock starts on a weekend", () => {
    // Sat 2026-11-21 10:00 PT to Mon 2026-11-23 05:00 PT.
    expect(weekdayHours(at("2026-11-21T18:00:00Z"), at("2026-11-23T13:00:00Z"))).toBe(5);
  });

  it("uses Pacific weekends, not UTC ones (Friday 20:00 PT is already Saturday in UTC)", () => {
    // Fri 2026-11-20 20:00 PT to Fri 23:00 PT: three weekday hours.
    expect(weekdayHours(at("2026-11-21T04:00:00Z"), at("2026-11-21T07:00:00Z"))).toBe(3);
  });

  it("is zero when the end is not after the start", () => {
    expect(weekdayHours(at("2026-11-18T00:00:00Z"), at("2026-11-17T00:00:00Z"))).toBe(0);
  });

  it("counts a whole week as five days", () => {
    expect(weekdayHours(at("2026-11-17T16:00:00Z"), at("2026-11-24T16:00:00Z"))).toBe(120);
  });
});

describe("addWeekdayHours", () => {
  it("lands on Monday when 24 weekday hours start on Friday evening", () => {
    // Fri 2026-11-20 18:00 PT + 24 weekday hours = Mon 2026-11-23 18:00 PT.
    expect(iso(addWeekdayHours(at("2026-11-21T02:00:00Z"), 24))).toBe("2026-11-24T02:00:00.000Z");
  });

  it("stays on the same day within the week", () => {
    // Tue 2026-11-17 08:00 PT + 24 = Wed 08:00 PT.
    expect(iso(addWeekdayHours(at("2026-11-17T16:00:00Z"), 24))).toBe("2026-11-18T16:00:00.000Z");
  });

  it("starts on Monday 00:00 PT when the start is on a weekend", () => {
    // Sun 2026-11-22 12:00 PT + 1 = Mon 2026-11-23 01:00 PT.
    expect(iso(addWeekdayHours(at("2026-11-22T20:00:00Z"), 1))).toBe("2026-11-23T09:00:00.000Z");
  });

  it("keeps Pacific clock time across the end of daylight saving time (2026-11-01)", () => {
    // Fri 2026-10-30 18:00 PDT (UTC-7) + 24 weekday hours = Mon 2026-11-02 18:00 PST (UTC-8).
    expect(iso(addWeekdayHours(at("2026-10-31T01:00:00Z"), 24))).toBe("2026-11-03T02:00:00.000Z");
  });

  it("keeps Pacific clock time across the start of daylight saving time (2026-03-08)", () => {
    // Fri 2026-03-06 18:00 PST (UTC-8) + 24 weekday hours = Mon 2026-03-09 18:00 PDT (UTC-7).
    expect(iso(addWeekdayHours(at("2026-03-07T02:00:00Z"), 24))).toBe("2026-03-10T01:00:00.000Z");
  });

  it("is the inverse of weekdayHours", () => {
    const start = at("2026-11-19T22:30:00Z");
    for (const h of [1, 12, 24, 48, 60, 100]) {
      expect(weekdayHours(start, addWeekdayHours(start, h))).toBeCloseTo(h, 6);
    }
  });
});
