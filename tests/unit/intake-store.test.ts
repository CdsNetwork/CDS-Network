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

describe("supabaseIntakeStore thread lookups", () => {
  /** A client that answers each table with fixed rows filtered by eq(), and records the calls. */
  function threadClient(rows: Record<string, Record<string, unknown>[]>) {
    const selects: Record<string, string> = {};
    const client = {
      from(table: string) {
        const filters: [string, unknown][] = [];
        const result = () => ({ data: (rows[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v)), error: null });
        const chain = {
          select(columns: string) {
            selects[table] = columns;
            return chain;
          },
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            return chain;
          },
          gte: () => chain,
          not: () => chain,
          order: () => chain,
          limit: async () => result(),
          maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
        };
        return chain;
      },
    };
    return { client, selects };
  }

  it("gives the order a stored email made or was linked to, with its number and status", async () => {
    const { supabaseIntakeStore } = await import("@/lib/intake/supabase-store");
    const { client } = threadClient({
      inbound_emails: [
        { provider_message_id: "<a@x>", in_reply_to: null, work_order_id: "wo-1", thread_reference: null },
        { provider_message_id: "<b@x>", in_reply_to: "<a@x>", work_order_id: null, thread_reference: { work_order_id: "wo-1", wo_number: 101370, via: "thread" } },
        { provider_message_id: "<c@x>", in_reply_to: "<b@x>", work_order_id: null, thread_reference: null },
      ],
      work_orders: [{ id: "wo-1", wo_number: 101370, status: "pending_review" }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = supabaseIntakeStore(client as any);
    const expected = { inReplyTo: null, workOrderId: "wo-1", woNumber: 101370, workOrderStatus: "pending_review" };
    expect(await store.threadEmail!("<a@x>")).toEqual(expected);
    expect(await store.threadEmail!("<b@x>")).toEqual({ ...expected, inReplyTo: "<a@x>" });
    expect(await store.threadEmail!("<c@x>")).toEqual({ inReplyTo: "<b@x>", workOrderId: null, woNumber: null, workOrderStatus: null });
    expect(await store.threadEmail!("<missing@x>")).toBeNull();
  });

  it("lists the customer's recent orders with the subject of the email that made each", async () => {
    const { supabaseIntakeStore } = await import("@/lib/intake/supabase-store");
    const { client, selects } = threadClient({
      work_orders: [
        { id: "wo-1", customer_id: "c1", wo_number: 101370, location_id: "l1", unit_number: "284177", created_at: "2026-10-27T17:43:00Z", inbound_emails: [{ subject: "***Ryder***" }] },
        { id: "wo-2", customer_id: "c1", wo_number: 101371, location_id: null, unit_number: null, created_at: "2026-10-27T18:00:00Z", inbound_emails: [] },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orders = await supabaseIntakeStore(client as any).recentOrders!("c1", "2026-10-13T00:00:00Z");
    expect(orders).toEqual([
      { id: "wo-1", woNumber: 101370, locationId: "l1", unitNumber: "284177", createdAt: "2026-10-27T17:43:00Z", subject: "***Ryder***" },
      { id: "wo-2", woNumber: 101371, locationId: null, unitNumber: null, createdAt: "2026-10-27T18:00:00Z", subject: null },
    ]);
    expect(selects.work_orders).toContain("inbound_emails!inbound_emails_work_order_id_fkey(subject)");
  });
});
