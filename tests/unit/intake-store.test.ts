/**
 * The intake store's reference data: items priced per line (Misc. hardware) are never loaded
 * for matching. The Supabase client is faked; only the catalog query is inspected.
 */
import { describe, expect, it, vi } from "vitest";
import { parseEmail } from "@/lib/intake/parse";
import { catalog as fixtureCatalog, fixture, reference as fixtureReference } from "../fixtures/intake/reference";

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
    const { client } = fakeClient({
      catalog_items: [
        { id: "c1", sku: "SVC-DPF", name: "DPF Cleaning", category: "service", oe_cross: null, active: true, price_per_line: false },
        { id: "c2", sku: "CDS-MISC-HARDWARE", name: "Misc. hardware", category: "hardware", oe_cross: null, active: true, price_per_line: true },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = await supabaseIntakeStore(client as any).reference();
    expect(ref.catalog.map((c) => c.sku)).toEqual(["SVC-DPF"]);
  });

  it("BUG-M2-8: the real reference lets intake warn when Misc. hardware is asked for", async () => {
    const { supabaseIntakeStore } = await import("@/lib/intake/supabase-store");
    const { client } = fakeClient({
      customers: [{ id: "00000000-0000-4000-8000-00000000c001", code: "RYDER", name: "Ryder", active: true }],
      catalog_items: [
        { id: "c1", sku: "SVC-DPF", name: "DPF Cleaning", category: "service", oe_cross: null, active: true, price_per_line: false },
        { id: "c2", sku: "CDS-MISC-HARDWARE", name: "Misc. hardware", category: "hardware", oe_cross: null, active: true, price_per_line: true },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = await supabaseIntakeStore(client as any).reference();
    expect(ref.catalog.map((c) => c.sku)).toEqual(["SVC-DPF"]);
    expect(ref.perLineItems.map((c) => c.sku)).toEqual(["CDS-MISC-HARDWARE"]);
    for (const line of ["Please add CDS-MISC-HARDWARE x2 and clean the DPF.", "Please send misc hardware (bolts and nuts)."]) {
      const email = { ...fixture("ryder-dpf-with-parts"), text: `Location: 0424\nUnit #: 284190\n\n${line}\n` };
      const p = await parseEmail(email, ref, { llm: null });
      expect(p.items.map((i) => i.catalog_item_id)).not.toContain("c2");
      expect(p.warnings).toContain("Misc. hardware is asked for: add it by hand with the amount from the shop's invoice.");
    }
  });

  it("the test fixture reference has the same shape as the real store's", async () => {
    const { supabaseIntakeStore } = await import("@/lib/intake/supabase-store");
    const { client } = fakeClient({ catalog_items: fixtureCatalog.map((c) => ({ ...c, active: true, price_per_line: !!c.price_per_line })) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const real = await supabaseIntakeStore(client as any).reference();
    const fake = fixtureReference();
    const ids = (r: { catalog: { id: string }[]; perLineItems: { id: string }[] }) => ({
      catalog: r.catalog.map((c) => c.id).sort(),
      perLineItems: r.perLineItems.map((c) => c.id).sort(),
    });
    expect(ids(fake)).toEqual(ids(real));
  });
});
