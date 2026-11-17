/**
 * "Shipped" in the status filter of the CDS dashboard (Sarah, CDS, 2026-11-17). Shipped is
 * not a work order status: it lists the orders whose leg from the shop back to the customer
 * (affiliate_to_customer) is with the carrier and not delivered yet, by the carrier status of
 * that shipment: picked up, in transit, out for delivery, delayed, exception or address
 * problem. A leg that only has a label (label_needed, label_created, awaiting_pickup, no_scan)
 * has not shipped; a delivered one is the Delivered status.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SHIPPED, SHIPPED_STATUSES, filteredWorkOrders, filterQuery, parseFilters } = await import("@/components/cds-wo/woFilters");

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function fakeSupabase() {
  const calls: [string, ...unknown[]][] = [];
  const list = new Proxy(
    {},
    {
      get(_t, name: string) {
        return (...args: unknown[]) => {
          calls.push([name, ...args]);
          return list;
        };
      },
    },
  );
  const supabase = { from: () => list };
  return { supabase, calls };
}

describe("Shipped filter", () => {
  it("is read from the status parameter and kept in links", () => {
    expect(SHIPPED).toBe("shipped");
    const f = parseFilters({ status: "shipped" });
    expect(f).toMatchObject({ status: "shipped", statuses: null, shipped: true, condemned: false });
    expect(filterQuery(f)).toBe("?status=shipped");
    expect(parseFilters({}).shipped).toBe(false);
  });

  it("uses the carrier statuses between pickup and delivery", () => {
    expect([...SHIPPED_STATUSES].sort()).toEqual(
      ["picked_up", "in_transit", "out_for_delivery", "delayed", "exception", "address_problem"].sort(),
    );
  });

  it("joins the outbound legs in those statuses, without a work order status filter", async () => {
    const { supabase, calls } = fakeSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkOrders(supabase as any, parseFilters({ status: "shipped" }), "id, status");
    expect(calls.find(([n]) => n === "select")?.[1]).toBe("id, status, shipped_legs:shipments!inner(id)");
    expect(calls).toContainEqual(["eq", "shipped_legs.direction", "affiliate_to_customer"]);
    expect(calls).toContainEqual(["in", "shipped_legs.status", SHIPPED_STATUSES]);
    expect(calls.some(([n, col]) => (n === "eq" || n === "in") && col === "status")).toBe(false);
  });

  it("is an option of the dashboard status filter", () => {
    expect(read("src/app/cds/page.tsx")).toMatch(/<option value=\{SHIPPED\}>Shipped<\/option>/);
  });
});
