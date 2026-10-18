/**
 * The intake store's reference data: items priced per line (Misc. hardware) are never loaded
 * for matching. The Supabase client is faked; only the catalog query is inspected.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Call = { table: string; filters: [string, unknown][] };

function fakeClient(rows: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        order: () => chain,
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        range: async () => {
          let data = rows[table] ?? [];
          for (const [column, value] of call.filters) data = data.filter((r) => (r as Record<string, unknown>)[column] === value);
          return { data, error: null };
        },
      };
      return chain;
    },
  };
  return { client, calls };
}

describe("supabaseIntakeStore.reference", () => {
  it("BUG-M2-5: leaves items priced per line out of the catalog used for matching", async () => {
    const { supabaseIntakeStore } = await import("@/lib/intake/supabase-store");
    const { client, calls } = fakeClient({
      catalog_items: [
        { id: "c1", sku: "SVC-DPF", name: "DPF Cleaning", category: "service", oe_cross: null, active: true, price_per_line: false },
        { id: "c2", sku: "CDS-MISC-HARDWARE", name: "Misc. hardware", category: "hardware", oe_cross: null, active: true, price_per_line: true },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = await supabaseIntakeStore(client as any).reference();
    expect(ref.catalog.map((c) => c.sku)).toEqual(["SVC-DPF"]);
    expect(calls.find((c) => c.table === "catalog_items")?.filters).toContainEqual(["price_per_line", false]);
  });
});
