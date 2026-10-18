import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { date, dateTime, idCell, SHIPMENT_STATUS_LABEL, wrapCell } from "@/lib/format";
it("BUG-8: times are shown in Pacific time", () => {
  expect(dateTime("2026-10-14T22:19:00+00:00")).toBe("2026-10-14 15:19 PT");
  expect(dateTime("2026-10-15T03:05:00Z")).toBe("2026-10-14 20:05 PT");
  expect(dateTime("2026-01-15T00:00:00Z")).toBe("2026-01-14 16:00 PT");
  expect(date("2026-10-15T03:05:00Z")).toBe("2026-10-14");
  expect(date("2026-01-01")).toBe("2026-01-01");
  expect(dateTime("2026-10-15T07:30:00Z")).toBe("2026-10-15 00:30 PT");
});

it("BUG-12: only free text with a very long word gets the wrapping cell class", () => {
  expect(wrapCell("QA3-P227191")).toBeUndefined();
  expect(wrapCell("1FUJGLDR7CLBP8834")).toBeUndefined();
  expect(wrapCell("9400111899223197428490")).toBeUndefined();
  expect(wrapCell("Lakeside yard, gate 3 behind the wash bay")).toBeUndefined();
  expect(wrapCell(null, undefined, "")).toBeUndefined();
  expect(wrapCell("X".repeat(100))).toBe("cell-wrap");
  expect(wrapCell("short", `see https://example.com/${"a".repeat(40)}`)).toBe("cell-wrap");
});

it("BUG-12: unit and PO numbers stay on one line unless they are one very long word", () => {
  expect(idCell("4500123456-01")).toBe("nowrap");
  expect(idCell(null)).toBe("nowrap");
  expect(idCell("9".repeat(100))).toBe("cell-wrap");
});

describe("SHIPMENT_STATUS_LABEL", () => {
  it("names every shipment status the database allows, including label_needed", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const sql = readdirSync(dir)
      .sort()
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    const created = /create type public\.shipment_status\s+as enum \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const added = [...sql.matchAll(/alter type public\.shipment_status add value if not exists '(\w+)'/g)].map((m) => m[1]);
    const values = [...[...created.matchAll(/'(\w+)'/g)].map((m) => m[1]), ...added];
    expect(values).toContain("label_needed");
    expect(Object.keys(SHIPMENT_STATUS_LABEL).sort()).toEqual([...values].sort());
    expect(SHIPMENT_STATUS_LABEL.label_needed).toBe("Needs Label");
  });
});
