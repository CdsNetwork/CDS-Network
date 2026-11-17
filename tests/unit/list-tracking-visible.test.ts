/**
 * Dashboard tracking numbers (Sarah, CDS, 2026-11-17): the work order list showed a leg's
 * tracking number only in a tooltip. Each leg now shows it as text, with "In" (to the shop or
 * CDS) or "Out" (back to the customer) next to it; the UPS Track link stays.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLegs, type LegRow } from "@/components/cds-wo/list-shipments";

const leg = (over: Partial<LegRow>): LegRow => ({
  id: "s1",
  direction: "customer_to_affiliate",
  status: "in_transit",
  carrier: "UPS",
  tracking_number: null,
  created_at: "2026-11-10T10:00:00Z",
  ...over,
});

describe("list legs carry the tracking number", () => {
  it("trimmed, or null when there is none", () => {
    const [a, b] = listLegs([leg({ id: "a", tracking_number: " 1Z999AA10123456784 " }), leg({ id: "b", tracking_number: "  " })]);
    expect(a.tracking).toBe("1Z999AA10123456784");
    expect(b.tracking).toBeNull();
  });
});

describe("the list row", () => {
  const edits = readFileSync(join(__dirname, "../../src/components/cds-wo/ListRowEdits.tsx"), "utf8");
  it("shows the tracking number as text next to In or Out, and keeps the Track link", () => {
    expect(edits).toMatch(/\{leg\.dir\}/);
    expect(edits).toMatch(/\{leg\.tracking \?\? /);
    expect(edits).toMatch(/leg\.trackingUrl/);
  });
});
