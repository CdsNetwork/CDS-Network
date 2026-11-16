/**
 * Items priced on the order (catalog_items.price_per_line, not pass_through: CDS-NEW-FILTER,
 * reconditioned filters) added without their amount
 * (20261117030000_order_priced_without_amount.sql; Sarah, CDS office, 2026-11-16).
 *
 * The Create Work Order form, the "Priced on this order" box and email intake can add such a
 * line with the amount left empty: no work_order_line_pricing row, "No price" on the line and
 * customer_price_missing on the order. CDS enters the amount on the line later
 * (public.cds_set_line_price) until the order is invoiced or cancelled, also after the shop
 * completed the work. Misc. hardware (pass_through) still needs its amount.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shop: string; customer: string; filter: string; misc: string; regular: string };

let f: Fixture;
let cds: Login;
let shop: Login;

const LABEL = `OP-${runId}`;
const MSG = (n: number) => `<order-priced-${runId}-${n}@test.invalid>`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const createArgs = (lines: { catalog_item_id: string; qty: number }[]) => ({
  p_customer: f.customer,
  p_location: null,
  p_location_label: LABEL,
  p_site_address: null,
  p_request_type: "parts_only",
  p_fulfillment: "shipping",
  p_unit_number: "OP-1",
  p_po_number: "PO-OP",
  p_requested_work: "New filter",
  p_internal_notes: null,
  p_lines: lines,
});

type LineRow = { id: string; catalog_item_id: string; price: number | null; source: string | null };

async function lines(wo: string): Promise<LineRow[]> {
  const rows = (await must(
    admin
      .from("work_order_lines")
      .select("id, catalog_item_id, created_at, work_order_line_pricing(customer_unit_price, price_source)")
      .eq("work_order_id", wo)
      .order("created_at"),
  )) as { id: string; catalog_item_id: string; work_order_line_pricing: unknown }[];
  return rows.map((r) => {
    const p = (Array.isArray(r.work_order_line_pricing) ? r.work_order_line_pricing[0] : r.work_order_line_pricing) as
      | { customer_unit_price: number; price_source: string }
      | null
      | undefined;
    return { id: r.id, catalog_item_id: r.catalog_item_id, price: p ? Number(p.customer_unit_price) : null, source: p?.price_source ?? null };
  });
}

const missing = async (wo: string) =>
  (
    (await must(
      cds.client.from("work_order_financials").select("customer_price_missing").eq("work_order_id", wo).single(),
    )) as { customer_price_missing: boolean }
  ).customer_price_missing;

async function newOrder(): Promise<string> {
  return (await must(cds.client.rpc("cds_create_work_order", createArgs([{ catalog_item_id: f.filter, qty: 1 }])))) as string;
}

beforeAll(async () => {
  const shopRow = await insertOne("affiliates", { short_code: `OP-${runId}`, display_name: `Shop OP ${runId}` });
  const customer = await insertOne("customers", { code: `OPC-${runId}`, name: `Ryder OP ${runId}` });
  const item = (sku: string, category: string, extra: Record<string, unknown> = {}) =>
    insertOne("catalog_items", { sku: `${sku}-${runId}`, category, name: `Test ${sku}`, tax_class: "parts", ...extra });
  const filter = await item("OPNEWF", "part", { shop_selectable: false, price_per_line: true, pass_through: false });
  const misc = await item("OPMISC", "part", { shop_selectable: false, price_per_line: true });
  const regular = await item("OPDPF", "service");
  await must(admin.from("sell_prices").insert({ catalog_item_id: regular.id, market: "US", amount: 325, effective_from: "2026-01-01" }));
  f = { shop: shopRow.id, customer: customer.id, filter: filter.id, misc: misc.id, regular: regular.id };
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", f.shop);
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
  const rowIds: string[] = [cds?.id, shop?.id].filter((v): v is string => !!v);
  let woIds: string[] = [];
  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["catalog_items", "sku"],
      ["affiliates", "short_code"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
    const wos = await must(admin.from("work_orders").select("id").eq("customer_id", f.customer));
    woIds = wos.map((r: { id: string }) => r.id);
    rowIds.push(...woIds);
    if (woIds.length) {
      rowIds.push(...(await must(admin.from("work_order_lines").select("id").in("work_order_id", woIds))).map((r: { id: string }) => r.id));
    }
  });
  await step("delete emails", () => must(admin.from("inbound_emails").delete().like("provider_message_id", `<order-priced-${runId}-%`)));
  if (woIds.length) {
    await step("delete sync rows", () => must(admin.from("integration_sync").delete().in("entity_id", woIds)));
    await step("delete work orders", () => must(admin.from("work_orders").delete().in("id", woIds)));
  }
  await step("delete logins", () => deleteLogins());
  await step("delete catalog items", () => must(admin.from("catalog_items").delete().like("sku", suffix)));
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("an item priced on the order, added without its amount", () => {
  it("the Create Work Order form adds it with no price", async () => {
    const res = await cds.client.rpc("cds_create_work_order", createArgs([{ catalog_item_id: f.filter, qty: 1 }]));
    expect(res.error?.message ?? null).toBeNull();
    const wo = res.data as string;
    expect((await lines(wo)).map((l) => [l.catalog_item_id, l.price])).toEqual([[f.filter, null]]);
    expect(await missing(wo)).toBe(true);
  });

  it("the Priced on this order box adds it with the amount left empty", async () => {
    const wo = (await must(cds.client.rpc("cds_create_work_order", createArgs([{ catalog_item_id: f.regular, qty: 1 }])))) as string;
    const res = await cds.client.rpc("cds_add_pass_through_line", {
      p_work_order: wo,
      p_catalog_item: f.filter,
      p_description: "",
      p_amount: null,
    });
    expect(res.error?.message ?? null).toBeNull();
    expect((await lines(wo)).map((l) => [l.catalog_item_id, l.price])).toEqual([
      [f.regular, 325],
      [f.filter, null],
    ]);
    expect(await missing(wo)).toBe(true);
  });

  it("email intake adds it to the draft with no price", async () => {
    const email = await insertOne<{ id: string }>("inbound_emails", {
      provider_message_id: MSG(1),
      received_at: new Date().toISOString(),
      from_address: `desk@op-${runId.toLowerCase()}.example`,
      subject: `Order priced ${runId}`,
      body_text: "New filter please",
      source: "webhook",
    });
    const res = await admin.rpc("intake_create_draft_work_order", {
      p_email: email.id,
      p_customer: f.customer,
      p_location: null,
      p_location_label: LABEL,
      p_site_address: null,
      p_request_type: "parts_only",
      p_fulfillment: "shipping",
      p_unit_number: null,
      p_po_number: null,
      p_requested_work: "New filter",
      p_internal_notes: null,
      p_review_reason: null,
      p_lines: [{ catalog_item_id: f.filter, qty: 1 }],
    });
    expect(res.error?.message ?? null).toBeNull();
    const wo = res.data as string;
    expect((await lines(wo)).map((l) => [l.catalog_item_id, l.price])).toEqual([[f.filter, null]]);
    const internal = await must(admin.from("work_order_internal").select("internal_notes").eq("work_order_id", wo).single());
    expect((internal as { internal_notes: string | null }).internal_notes ?? "").not.toContain("Not added");
  });

  it("Misc. hardware still needs the amount from the shop's invoice", async () => {
    const wo = await newOrder();
    const res = await cds.client.rpc("cds_add_pass_through_line", {
      p_work_order: wo,
      p_catalog_item: f.misc,
      p_description: "Bolts",
      p_amount: null,
    });
    expect(res.error).not.toBeNull();
    const create = await cds.client.rpc("cds_create_work_order", createArgs([{ catalog_item_id: f.misc, qty: 1 }]));
    expect(create.error).not.toBeNull();
  });

  it("a shop cannot add it", async () => {
    const wo = await newOrder();
    await must(admin.from("work_orders").update({ affiliate_id: f.shop, status: "in_process" }).eq("id", wo));
    const res = await shop.client.rpc("shop_add_part", { p_work_order: wo, p_catalog_item: f.filter, p_qty: 1 });
    expect(res.error).not.toBeNull();
  });
});

describe("CDS enters the amount on the line later", () => {
  it("sets it, logs it on the order (CDS only), and the order no longer misses a price", async () => {
    const wo = await newOrder();
    const [line] = await lines(wo);
    const res = await cds.client.rpc("cds_set_line_price", { p_line: line.id, p_amount: 410 });
    expect(res.error?.message ?? null).toBeNull();
    expect((await lines(wo))[0]).toMatchObject({ price: 410, source: "manual" });
    expect(await missing(wo)).toBe(false);
    const events = await must(
      admin.from("work_order_events").select("message, shop_visible").eq("work_order_id", wo).eq("event_type", "line_price_set"),
    );
    expect(events).toEqual([{ message: `CDS set the price for Test OPNEWF: $410.00`, shop_visible: false }]);

    // A typo is corrected the same way.
    await must(cds.client.rpc("cds_set_line_price", { p_line: line.id, p_amount: 415.5 }));
    expect((await lines(wo))[0].price).toBe(415.5);
  });

  it("works after the shop completed the work", async () => {
    const wo = await newOrder();
    await must(admin.from("work_orders").update({ affiliate_id: f.shop, status: "completed", affiliate_invoice_ref: "INV-1" }).eq("id", wo));
    const [line] = await lines(wo);
    const res = await cds.client.rpc("cds_set_line_price", { p_line: line.id, p_amount: 410 });
    expect(res.error?.message ?? null).toBeNull();
    expect((await lines(wo))[0].price).toBe(410);
  });

  it("is refused once the order is invoiced or cancelled", async () => {
    const invoiced = await newOrder();
    await must(
      admin.from("work_orders").update({ affiliate_id: f.shop, status: "invoiced", affiliate_invoice_ref: "INV-2" }).eq("id", invoiced),
    );
    const [a] = await lines(invoiced);
    expect((await cds.client.rpc("cds_set_line_price", { p_line: a.id, p_amount: 410 })).error).not.toBeNull();

    const cancelled = await newOrder();
    await must(cds.client.rpc("cds_set_status", { p_work_order: cancelled, p_status: "cancelled", p_note: null }));
    const [b] = await lines(cancelled);
    expect((await cds.client.rpc("cds_set_line_price", { p_line: b.id, p_amount: 410 })).error).not.toBeNull();
    expect((await lines(cancelled))[0].price).toBeNull();
  });

  it("is refused for other lines, bad amounts and shops", async () => {
    const wo = (await must(cds.client.rpc("cds_create_work_order", createArgs([{ catalog_item_id: f.regular, qty: 1 }])))) as string;
    const [regular] = await lines(wo);
    expect((await cds.client.rpc("cds_set_line_price", { p_line: regular.id, p_amount: 1 })).error).not.toBeNull();
    const misc = (await must(
      cds.client.rpc("cds_add_pass_through_line", { p_work_order: wo, p_catalog_item: f.misc, p_description: "Bolts", p_amount: 12 }),
    )) as string;
    expect((await cds.client.rpc("cds_set_line_price", { p_line: misc, p_amount: 1 })).error).not.toBeNull();

    const other = await newOrder();
    const [line] = await lines(other);
    for (const bad of [0, -1, 1.234, 100000]) {
      expect((await cds.client.rpc("cds_set_line_price", { p_line: line.id, p_amount: bad })).error, String(bad)).not.toBeNull();
    }
    expect((await shop.client.rpc("cds_set_line_price", { p_line: line.id, p_amount: 410 })).error).not.toBeNull();
    expect((await lines(other))[0].price).toBeNull();
  });
});
