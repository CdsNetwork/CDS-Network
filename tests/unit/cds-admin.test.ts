import { expect, it } from "vitest";
import { pacificToday } from "@/lib/dates";
import { belowShopRate, BELOW_SHOP_RATE_MESSAGE } from "@/components/cds-admin/margin";
import { isVisibleChange } from "@/components/cds-admin/audit";

it("BUG-17: today for price queries is the Pacific date", () => {
  // 22:56 PDT on 2026-10-14 is 05:56 UTC on 2026-10-15.
  expect(pacificToday(new Date("2026-10-15T05:56:00Z"))).toBe("2026-10-14");
  expect(pacificToday(new Date("2026-10-15T07:00:00Z"))).toBe("2026-10-15");
  // Winter (PST, UTC-8).
  expect(pacificToday(new Date("2026-01-15T07:59:00Z"))).toBe("2026-01-14");
  expect(pacificToday(new Date("2026-01-15T08:00:00Z"))).toBe("2026-01-15");
});

it("a customer price below the shop rate is flagged, equal or above is not", () => {
  expect(belowShopRate("17.92", "11.11")).toBe(true);
  expect(belowShopRate(17.92, 17.92)).toBe(false);
  expect(belowShopRate(10, 12)).toBe(false);
  expect(belowShopRate(null, 5)).toBe(false);
  expect(belowShopRate(5, null)).toBe(false);
  expect(BELOW_SHOP_RATE_MESSAGE).toBe("Customer price is below what CDS pays the shop");
});

it("change log rows that differ only in updated_at or updated_by are not visible changes", () => {
  const old = { id: "1", name: "A", updated_at: "2026-10-15T01:00:00Z", updated_by: "x" };
  expect(isVisibleChange({ action: "update", old_data: old, new_data: { ...old, updated_at: "2026-10-15T02:00:00Z", updated_by: "y" } })).toBe(false);
  expect(isVisibleChange({ action: "update", old_data: old, new_data: { ...old, name: "B" } })).toBe(true);
  expect(isVisibleChange({ action: "insert", old_data: null, new_data: old })).toBe(true);
  expect(isVisibleChange({ action: "delete", old_data: old, new_data: null })).toBe(true);
});
