/**
 * Work orders with an item that has no customer price yet
 * (20261117010000_work_order_without_price.sql; Sarah, CDS office, 2026-11-16).
 *
 * CDS can create the order, and add the item to an existing order, while the item has no
 * customer price and no fleet price: the line is added without a price (no
 * work_order_line_pricing row) and work_order_financials.customer_price_missing says so.
 * Setting the fleet price (Catalog) or the customer's price (Pricing) fills it in on that
 * item's open orders; invoiced and cancelled orders keep what they have. The QuickBooks
 * invoice is refused while a line has no price (tests/unit/no-price-work-order.test.ts).
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { ryder: string; other: string; priced: string; filter: string; filter2: string };

let f: Fixture;
let cds: Login;

const LABEL = `NP-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const createArgs = (customer: string, lines: { catalog_item_id: string; qty: number }[]) => ({
  p_customer: customer,
  p_location: null,
  p_location_label: LABEL,
  p_site_address: null,
  p_request_type: "service",
  p_fulfillment: "shipping",
  p_unit_number: "NP-1",
  p_po_number: "PO-NP",
  p_requested_work: "New filter",
  p_internal_notes: null,
  p_lines: lines,
});

async function prices(wo: string): Promise<Record<string, { price: number; source: string } | null>> {
  const rows = (await must(
    admin
      .from("work_order_lines")
      .select("catalog_item_id, work_order_line_pricing(customer_unit_price, price_source)")
      .eq("work_order_id", wo),
  )) as { catalog_item_id: string; work_order_line_pricing: unknown }[];
  const out: Record<string, { price: number; source: string } | null> = {};
  for (const r of rows) {
    const p = (Array.isArray(r.work_order_line_pricing) ? r.work_order_line_pricing[0] : r.work_order_line_pricing) as
      | { customer_unit_price: number; price_source: string }
      | null
      | undefined;
    out[r.catalog_item_id] = p ? { price: Number(p.customer_unit_price), source: p.price_source } : null;
  }
  return out;
}

const financials = (wo: string) =>
  must(
    cds.client
      .from("work_order_financials")
      .select("customer_subtotal, customer_price_missing")
      .eq("work_order_id", wo)
      .single(),
  );

beforeAll(async () => {
  const ryder = await insertOne("customers", { code: `NPR-${runId}`, name: `Ryder NP ${runId}` });
  const other = await insertOne("customers", { code: `NPO-${runId}`, name: `Other NP ${runId}` });
  const item = (sku: string, category: string) =>
    insertOne("catalog_items", { sku: `${sku}-${runId}`, category, name: `Test ${sku}`, tax_class: "parts" });
  const priced = await item("NPDPF", "service");
  const filter = await item("NPNEWF", "part");
  const filter2 = await item("NPNEWF2", "part");
  await must(admin.from("sell_prices").insert({ catalog_item_id: priced.id, market: "US", amount: 325, effective_from: "2026-01-01" }));
  f = { ryder: ryder.id, other: other.id, priced: priced.id, filter: filter.id, filter2: filter2.id };
  cds = await createLogin("cds", null);
}, 120_000);

afterAll(async () => {
  const errors: string[] = [];
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const suffix = `%-${runId}`;
  const rowIds: string[] = [cds?.id].filter((v): v is string => !!v);
  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["catalog_items", "sku"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
    const wos = await must(admin.from("work_orders").select("id").eq("location_label", LABEL));
    const woIds = wos.map((r: { id: string }) => r.id);
    rowIds.push(...woIds);
    if (woIds.length) {
      rowIds.push(...(await must(admin.from("work_order_lines").select("id").in("work_order_id", woIds))).map((r: { id: string }) => r.id));
    }
  });
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete catalog items", () => must(admin.from("catalog_items").delete().like("sku", suffix)));
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("an item with no price", () => {
  let wo: string;

  it("CDS creates the work order anyway; the line has no price and the order says so", async () => {
    const res = await cds.client.rpc(
      "cds_create_work_order",
      createArgs(f.ryder, [
        { catalog_item_id: f.priced, qty: 1 },
        { catalog_item_id: f.filter, qty: 1 },
      ]),
    );
    expect(res.error?.message ?? null).toBeNull();
    wo = res.data as string;
    expect(await prices(wo)).toEqual({ [f.priced]: { price: 325, source: "fleet" }, [f.filter]: null });
    expect(await financials(wo)).toEqual({ customer_subtotal: 325, customer_price_missing: true });
  });

  it("CDS adds it to an existing order (+ Add Item)", async () => {
    const ins = await cds.client
      .from("work_order_lines")
      .insert({ work_order_id: wo, catalog_item_id: f.filter2, qty: 2, origin: "cds_order" });
    expect(ins.error?.message ?? null).toBeNull();
    expect((await prices(wo))[f.filter2]).toBeNull();
  });

  it("an order whose lines all have prices says nothing is missing", async () => {
    const res = await cds.client.rpc("cds_create_work_order", createArgs(f.ryder, [{ catalog_item_id: f.priced, qty: 2 }]));
    expect(res.error?.message ?? null).toBeNull();
    expect(await financials(res.data as string)).toEqual({ customer_subtotal: 650, customer_price_missing: false });
  });
});

describe("setting the price later", () => {
  it("the customer's price fills that customer's open orders only; the fleet price fills the rest", async () => {
    const ryderWo = must(cds.client.rpc("cds_create_work_order", createArgs(f.ryder, [{ catalog_item_id: f.filter, qty: 1 }])));
    const otherWo = must(cds.client.rpc("cds_create_work_order", createArgs(f.other, [{ catalog_item_id: f.filter, qty: 3 }])));
    const [r, o] = (await Promise.all([ryderWo, otherWo])) as string[];
    // A cancelled order keeps what it has.
    const cancelled = (await must(cds.client.rpc("cds_create_work_order", createArgs(f.other, [{ catalog_item_id: f.filter, qty: 1 }])))) as string;
    await must(cds.client.rpc("cds_set_status", { p_work_order: cancelled, p_status: "cancelled", p_note: null }));

    await must(cds.client.rpc("cds_set_price", { p_kind: "override", p_catalog_item: f.filter, p_customer: f.ryder, p_amount: 410 }));
    expect((await prices(r))[f.filter]).toEqual({ price: 410, source: "customer_override" });
    expect((await prices(o))[f.filter]).toBeNull();
    expect(await financials(r)).toEqual({ customer_subtotal: 410, customer_price_missing: false });

    await must(cds.client.rpc("cds_set_price", { p_kind: "fleet", p_catalog_item: f.filter, p_customer: null, p_amount: 450 }));
    expect((await prices(o))[f.filter]).toEqual({ price: 450, source: "fleet" });
    expect(await financials(o)).toEqual({ customer_subtotal: 1350, customer_price_missing: false });
    // Already priced: unchanged.
    expect((await prices(r))[f.filter]).toEqual({ price: 410, source: "customer_override" });
    expect((await prices(cancelled))[f.filter]).toBeNull();

    // The order's history says the price was set; the shop does not see it.
    const events = await must(
      admin.from("work_order_events").select("event_type, message, shop_visible").eq("work_order_id", o).eq("event_type", "line_price_set"),
    );
    expect(events).toEqual([{ event_type: "line_price_set", message: `Price set for NPNEWF-${runId}: $450.00 each`, shop_visible: false }]);
  });
});
