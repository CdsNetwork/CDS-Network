import { expect, it } from "vitest";
import { date, dateTime } from "@/lib/format";
it("BUG-8: times are shown in Pacific time", () => {
  expect(dateTime("2026-10-14T22:19:00+00:00")).toBe("2026-10-14 15:19 PT");
  expect(dateTime("2026-10-15T03:05:00Z")).toBe("2026-10-14 20:05 PT");
  expect(dateTime("2026-01-15T00:00:00Z")).toBe("2026-01-14 16:00 PT");
  expect(date("2026-10-15T03:05:00Z")).toBe("2026-10-14");
  expect(date("2026-01-01")).toBe("2026-01-01");
  expect(dateTime("2026-10-15T07:30:00Z")).toBe("2026-10-15 00:30 PT");
});
