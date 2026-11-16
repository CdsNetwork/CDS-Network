/**
 * Shipping queue: every leg that is not finished stays listed however old it is, not only
 * legs with a label problem or in transit (review finding M7, 2026-11-16).
 */
import { describe, expect, it } from "vitest";
import { isOpenShipment, mergeShipmentQueue, openShipmentFilter } from "@/app/cds/shipping/queue";
import { SHIPMENT_STATUS_LABEL } from "@/lib/format";
import { LABEL_STATUSES } from "@/app/cds/shipping/options";

const OPEN_LABEL = ["needed", "error"];
const RECENT = 300;

type Leg = { id: string; created_at: string; label_status: string; status: string };

/** Evaluates the PostgREST `or` filters the page sends: `col.in.(a,b)` and `col.not.in.(a,b)`. */
function matchesOr(filter: string, row: Record<string, string>): boolean {
  const parts = filter.match(/[a-z_]+\.(?:not\.)?in\.\([^)]*\)/g) ?? [];
  expect(parts.join(",")).toBe(filter);
  return parts.some((part) => {
    const m = part.match(/^([a-z_]+)\.(not\.)?in\.\(([^)]*)\)$/)!;
    const hit = m[3].split(",").includes(row[m[1]]);
    return m[2] ? !hit : hit;
  });
}

/** The page's two queries against an in-memory table: the newest legs, and the open legs. */
function shippingQueue(table: Leg[]): Leg[] {
  const newestFirst = [...table].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const recent = newestFirst.slice(0, RECENT);
  const open = newestFirst.filter((s) => matchesOr(openShipmentFilter(OPEN_LABEL), s));
  return mergeShipmentQueue(open, recent);
}

function table(old: Leg): Leg[] {
  const newer = Array.from({ length: RECENT + 50 }, (_, i) => ({
    id: `new-${i}`,
    created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
    label_status: "printed",
    status: "delivered",
  }));
  return [old, ...newer];
}

const oldLeg = (status: string, label_status = "printed"): Leg => ({
  id: `old-${status}-${label_status}`,
  created_at: "2026-01-05T12:00:00.000Z",
  label_status,
  status,
});

describe("shipping queue", () => {
  it("lists an old leg with an address problem whose label is fine, outside the newest legs", () => {
    const queue = shippingQueue(table(oldLeg("address_problem")));
    expect(queue.map((s) => s.id)).toContain("old-address_problem-printed");
  });

  it.each(["label_needed", "label_created", "awaiting_pickup", "delayed", "exception", "address_problem", "no_scan", "picked_up", "in_transit", "out_for_delivery"])(
    "lists an old %s leg",
    (status) => {
      expect(shippingQueue(table(oldLeg(status))).map((s) => s.id)).toContain(oldLeg(status).id);
    },
  );

  it("drops an old delivered leg with a settled label once it is past the newest legs", () => {
    expect(shippingQueue(table(oldLeg("delivered"))).map((s) => s.id)).not.toContain(oldLeg("delivered").id);
  });

  it("still lists an old delivered leg whose label is needed or failed (the label tile counts it)", () => {
    for (const label of OPEN_LABEL) {
      expect(shippingQueue(table(oldLeg("delivered", label))).map((s) => s.id)).toContain(oldLeg("delivered", label).id);
    }
  });

  it("every status the app knows is either finished or listed", () => {
    for (const status of Object.keys(SHIPMENT_STATUS_LABEL)) {
      expect(isOpenShipment({ status, label_status: "printed" }, OPEN_LABEL)).toBe(status !== "delivered");
    }
  });

  it("the query filter and the per-leg rule agree for every status and label status", () => {
    for (const status of Object.keys(SHIPMENT_STATUS_LABEL)) {
      for (const { value: label_status } of LABEL_STATUSES) {
        const row = { status, label_status };
        expect(matchesOr(openShipmentFilter(OPEN_LABEL), row)).toBe(isOpenShipment(row, OPEN_LABEL));
      }
    }
  });
});

describe("shipping page", () => {
  it("reads open legs with the shared filter and merges them with the newest legs", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../../src/app/cds/shipping/page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/\.or\(openShipmentFilter\(OPEN_LABEL\)\)/);
    expect(page).toMatch(/mergeShipmentQueue\(/);
  });
});
