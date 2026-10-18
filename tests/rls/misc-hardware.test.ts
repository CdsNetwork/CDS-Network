/**
 * Misc. hardware (items priced per line) and customer part numbers with descriptions.
 *
 * CDS adds a Misc. hardware line with the amount from the shop's invoice through
 * cds_add_pass_through_line: the shop is paid that amount and the customer is billed the
 * same (margin 0, taxed as parts). Shops see the line and its description (lines are
 * shop-visible) and their own pay, never the customer price; they cannot add, remove or
 * request such a line. Customer part numbers and their descriptions stay CDS only.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shop: string; customer: string; misc: string; part: string; aliasId: string };

let f: Fixture;
let cds: Login;
let shop: Login;

const LABEL = `MISC-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(status: string, unit: string): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: f.customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: f.shop,
    status,
    unit_number: unit,
    requested_work: "Test cleaning",
    affiliate_invoice_ref: ["completed", "delivered", "ready_to_invoice", "invoiced"].includes(status) ? "INV-1" : null,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

const addMisc = (client: Login["client"], wo: string, description: string, amount: number, item = f.misc) =>
  client.rpc("cds_add_pass_through_line", {
    p_work_order: wo,
    p_catalog_item: item,
    p_description: description,
    p_amount: amount,
  });

beforeAll(async () => {
  const shopRow = await insertOne("affiliates", { short_code: `MS-${runId}`, display_name: `Shop Misc ${runId}` });
  const customer = await insertOne("customers", { code: `MC-${runId}`, name: `Customer Misc ${runId}` });
  // The migration seeds CDS-MISC-HARDWARE; the suite uses its own item priced per line so it
  // never touches CDS's row.
  const misc = await insertOne("catalog_items", {
    sku: `MH-${runId}`,
    category: "part",
    name: "Test Misc. hardware",
    tax_class: "parts",
    shop_selectable: false,
    price_per_line: true,
  });
  const part = await insertOne("catalog_items", { sku: `MP-${runId}`, category: "part", name: "Test part", tax_class: "parts" });
  const alias = await insertOne("customer_item_aliases", {
    customer_id: customer.id,
    catalog_item_id: part.id,
    customer_part_number: `FS-${runId}`,
    customer_description: "GASKET, FILTER, PARTICULATE",
  });
  f = { shop: shopRow.id, customer: customer.id, misc: misc.id, part: part.id, aliasId: alias.id };
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
  const rowIds: string[] = [f?.aliasId, cds?.id, shop?.id].filter((v): v is string => !!v);
  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["catalog_items", "sku"],
      ["affiliates", "short_code"],
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
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("Misc. hardware lines", () => {
  it("CDS adds one with the shop invoice amount: shop pay = customer price, margin 0, taxed as parts", async () => {
    const wo = await workOrder("completed", "MH-1");
    const id = await must(addMisc(cds.client, wo, " Bolts and nuts for DPF kit ", 7.43));
    expect(typeof id).toBe("string");

    const line = await must(
      admin.from("work_order_lines").select("qty, shop_unit_rate, shop_rate_source, description, origin").eq("work_order_id", wo).single(),
    );
    expect(line).toEqual({
      qty: 1,
      shop_unit_rate: 7.43,
      shop_rate_source: "manual",
      description: "Bolts and nuts for DPF kit",
      origin: "cds_order",
    });
    const pricing = await must(
      admin.from("work_order_line_pricing").select("customer_unit_price, price_source, tax_class").eq("work_order_id", wo).single(),
    );
    expect(pricing).toEqual({ customer_unit_price: 7.43, price_source: "manual", tax_class: "parts" });
    const fin = await must(
      cds.client.from("work_order_financials").select("customer_subtotal, shop_subtotal, margin_before_shipping").eq("work_order_id", wo).single(),
    );
    expect(fin).toEqual({ customer_subtotal: 7.43, shop_subtotal: 7.43, margin_before_shipping: 0 });
    const events = await must(admin.from("work_order_events").select("event_type, actor_id, shop_visible").eq("work_order_id", wo));
    expect(events).toEqual([{ event_type: "line_added", actor_id: cds.id, shop_visible: true }]);
  });

  it("a shop sees the line and its description but never the customer price", async () => {
    const wo = await workOrder("completed", "MH-2");
    await must(addMisc(cds.client, wo, "Clamp bolts", 3.1));
    const lines = await must(shop.client.from("work_order_lines").select("description, shop_unit_rate").eq("work_order_id", wo));
    expect(lines).toEqual([{ description: "Clamp bolts", shop_unit_rate: 3.1 }]);
    const { data, error } = await shop.client.from("work_order_line_pricing").select("*").eq("work_order_id", wo);
    expect(error ? [] : data).toEqual([]);
    const fin = await shop.client.from("work_order_financials").select("*").eq("work_order_id", wo);
    expect(fin.error ? [] : fin.data).toEqual([]);
  });

  it("shops and anonymous callers cannot add or remove one", async () => {
    const wo = await workOrder("completed", "MH-3");
    for (const client of [shop.client, anon()]) {
      const { error } = await addMisc(client, wo, "Shop bolts", 5);
      expect(error).not.toBeNull();
    }
    const id = (await must(addMisc(cds.client, wo, "Bolts", 5))) as string;
    for (const client of [shop.client, anon()]) {
      const { error } = await client.rpc("cds_remove_pass_through_line", { p_line: id });
      expect(error).not.toBeNull();
    }
    const left = await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo));
    expect(left).toHaveLength(1);
  });

  it("a shop cannot add the item as a part, and a line without the CDS amount is refused", async () => {
    const wo = await workOrder("in_process", "MH-4");
    const part = await shop.client.rpc("shop_add_part", { p_work_order: wo, p_catalog_item: f.misc, p_qty: 1 });
    expect(part.error).not.toBeNull();
    const direct = await cds.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: f.misc, qty: 1 });
    expect(direct.error?.message).toMatch(/amount from the shop's invoice/);
    const lines = await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo));
    expect(lines).toEqual([]);
  });

  it("refuses a blank description, a bad amount, an item not priced per line, and an invoiced or cancelled order", async () => {
    const wo = await workOrder("ready_to_invoice", "MH-5");
    expect((await addMisc(cds.client, wo, "  ", 5)).error).not.toBeNull();
    for (const amount of [0, -1, 1.234, 100000]) {
      expect((await addMisc(cds.client, wo, "Bolts", amount)).error, String(amount)).not.toBeNull();
    }
    expect((await addMisc(cds.client, wo, "Bolts", 5, f.part)).error?.message).toMatch(/not priced per line/);
    for (const status of ["invoiced", "cancelled"]) {
      const closed = await workOrder(status, `MH-${status}`);
      expect((await addMisc(cds.client, closed, "Bolts", 5)).error?.message, status).toMatch(/invoiced or cancelled/);
    }
    const lines = await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo));
    expect(lines).toEqual([]);
  });

  it("CDS removes one until the order is invoiced", async () => {
    const wo = await workOrder("ready_to_invoice", "MH-6");
    const id = (await must(addMisc(cds.client, wo, "Wrong amount", 50))) as string;
    await must(cds.client.rpc("cds_remove_pass_through_line", { p_line: id }));
    expect(await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo))).toEqual([]);

    const kept = (await must(addMisc(cds.client, wo, "Bolts", 5))) as string;
    await must(admin.from("work_orders").update({ status: "invoiced" }).eq("id", wo));
    const late = await cds.client.rpc("cds_remove_pass_through_line", { p_line: kept });
    expect(late.error?.message).toMatch(/invoiced or cancelled/);
  });
});

describe("customer part numbers with descriptions", () => {
  it("a shop and an anonymous caller read none of them", async () => {
    for (const client of [shop.client, anon()]) {
      const { data, error } = await client.from("customer_item_aliases").select("customer_part_number, customer_description");
      expect(error ? [] : data).toEqual([]);
    }
    const write = await shop.client.from("customer_item_aliases").update({ customer_description: "X" }).eq("id", f.aliasId);
    expect(write.error ? [] : write.data ?? []).toEqual([]);
    const row = await must(admin.from("customer_item_aliases").select("customer_description").eq("id", f.aliasId).single());
    expect(row.customer_description).toBe("GASKET, FILTER, PARTICULATE");
  });

  it("CDS reads and edits the description; a blank description is refused", async () => {
    const rows = await must(cds.client.from("customer_item_aliases").select("customer_description").eq("id", f.aliasId));
    expect(rows).toEqual([{ customer_description: "GASKET, FILTER, PARTICULATE" }]);
    const blank = await cds.client.from("customer_item_aliases").update({ customer_description: "  " }).eq("id", f.aliasId);
    expect(blank.error?.code).toBe("23514");
    await must(cds.client.from("customer_item_aliases").update({ customer_description: null }).eq("id", f.aliasId));
  });
});
