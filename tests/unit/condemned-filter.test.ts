/**
 * "Condemned" in the status filter of the CDS work order list (CDS, 2026-11-12). Condemned is
 * not a work order status but the result of a component, so the option lists the orders with at
 * least one condemned component, and it works with the search text.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { CONDEMNED, filteredWorkOrders, filterQuery, parseFilters } = await import("@/components/cds-wo/woFilters");

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** A query builder that records every call made on the work_orders list. */
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
  const customers = {
    select: () => customers,
    ilike: () => customers,
    limit: async () => ({ data: [], error: null }),
  };
  const supabase = { from: (table: string) => (table === "customers" ? customers : list) };
  return { supabase, calls };
}

describe("Condemned filter", () => {
  it("is read from the status parameter and kept in links and the CSV export", () => {
    expect(CONDEMNED).toBe("condemned");
    const f = parseFilters({ status: "condemned", q: "284177" });
    expect(f).toMatchObject({ status: "condemned", statuses: null, condemned: true, q: "284177" });
    expect(filterQuery(f)).toBe("?q=284177&status=condemned");
    expect(parseFilters({}).condemned).toBe(false);
    expect(parseFilters({ status: "in_progress" }).condemned).toBe(false);
  });

  it("lists only orders with a condemned component, without a status filter, and with the search", async () => {
    const { supabase, calls } = fakeSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkOrders(supabase as any, parseFilters({ status: "condemned", q: "284177" }), "id, status");
    const select = calls.find(([n]) => n === "select");
    expect(select?.[1]).toBe("id, status, condemned_components:work_order_components!inner(id)");
    expect(calls).toContainEqual(["eq", "condemned_components.result", "condemned"]);
    expect(calls.some(([n, col]) => (n === "eq" || n === "in") && col === "status")).toBe(false);
    expect(calls.some(([n, ors]) => n === "or" && String(ors).includes("unit_number.ilike"))).toBe(true);
  });

  it("does not join the components for other filters", async () => {
    const { supabase, calls } = fakeSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkOrders(supabase as any, parseFilters({ status: "in_progress" }), "id, status");
    expect(calls.find(([n]) => n === "select")?.[1]).toBe("id, status");
  });

  it("is one more option of the status select on the list", () => {
    const page = read("src/app/cds/page.tsx");
    expect(page).toMatch(/<option value=\{CONDEMNED\}>Condemned<\/option>/);
  });
});
