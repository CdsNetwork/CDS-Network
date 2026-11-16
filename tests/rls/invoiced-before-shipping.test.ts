/**
 * An order invoiced before it is shipped (20261116010000_invoiced_shipping_and_shop_rate.sql).
 *
 * CDS may invoice at any time (20261112040000_invoice_any_time.sql). When the order has a
 * QuickBooks invoice before the shop completes it, completion moves it straight to Invoiced
 * with the shipping status Ready to Ship. The shop must still be able to mark it Shipped, and
 * CDS must still be able to enter a shop rate that was TBD (it comes with the shop's invoice).
 * A cancelled order, an order the shop never completed, and a pickup job stay refused, and a
 * shop rate already entered does not change once the order is invoiced.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `IBS-${runId}`;
let shopId: string;
let customer: string;
let part: string;
let cds: Login;
let shop: Login;
let seq = 0;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

/** An order the shop is working on, with one line whose shop rate is TBD and one component. */
async function workOrder(fulfillment = "shipping"): Promise<{ id: string; line: string }> {
  seq += 1;
  const wo = await insertOne<{ id: string }>("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment,
    affiliate_id: shopId,
    status: "in_process",
    unit_number: `U-${seq}`,
    requested_work: "Test cleaning",
    request_type: "service",
    pickup_window: fulfillment === "pickup" ? "10-12" : null,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  const line = await insertOne<{ id: string }>("work_order_lines", { work_order_id: wo.id, catalog_item_id: part, qty: 1, origin: "cds_order" });
  await must(
    admin.from("work_order_components").insert({
      work_order_id: wo.id,
      seq: 1,
      component_type: "EGR",
      manufacturer: "Test",
      part_number: `PN-${runId}`,
      serial_number: `SN-${runId}-${seq}`,
      result: "passed",
    }),
  );
  return { id: wo.id, line: line.id };
}

/** CDS invoices first, then the shop completes: the order lands on Invoiced. */
async function invoicedBeforeCompletion(fulfillment = "shipping") {
  const wo = await workOrder(fulfillment);
  await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo.id, p_qb_invoice_id: `IBS${runId}${seq}`, p_qb_invoice_number: null }));
  await must(shop.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "SHOP-1" }));
  return wo;
}

const order = async (id: string) =>
  must(admin.from("work_orders").select("status, shop_ship_status").eq("id", id).single()) as Promise<{ status: string; shop_ship_status: string | null }>;
const rateOf = async (line: string) =>
  (await must(admin.from("work_order_lines").select("shop_unit_rate").eq("id", line).single())).shop_unit_rate as number | null;

beforeAll(async () => {
  shopId = (await insertOne("affiliates", { short_code: `IBS-${runId}`, display_name: `Shop IBS ${runId}` })).id;
  customer = (await insertOne("customers", { code: `IBS-${runId}`, name: `Customer IBS ${runId}` })).id;
  // A part with a customer price and no shop rate: the line's shop rate is TBD.
  part = (await insertOne("catalog_items", { sku: `IBSP-${runId}`, category: "part", name: "Test part", tax_class: "parts" })).id;
  await must(admin.from("sell_prices").insert({ catalog_item_id: part, market: "US", amount: 30, effective_from: "2026-01-01" }));
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("catalog_items").delete().eq("id", part);
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().eq("id", shopId);
}, 120_000);

describe("shipping status on an order invoiced before the shop shipped it", () => {
  it("the shop can mark it Shipped", async () => {
    const wo = await invoicedBeforeCompletion();
    expect(await order(wo.id)).toEqual({ status: "invoiced", shop_ship_status: "ready_to_ship" });
    await must(shop.client.rpc("shop_set_ship_status", { p_work_order: wo.id, p_status: "shipped" }));
    expect(await order(wo.id)).toEqual({ status: "invoiced", shop_ship_status: "shipped" });
  });

  it("also after CDS invoiced a completed order the shop had not shipped yet", async () => {
    const wo = await workOrder();
    await must(shop.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "SHOP-2" }));
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo.id, p_qb_invoice_id: `IBS${runId}x`, p_qb_invoice_number: null }));
    await must(shop.client.rpc("shop_set_ship_status", { p_work_order: wo.id, p_status: "shipped" }));
    expect(await order(wo.id)).toEqual({ status: "invoiced", shop_ship_status: "shipped" });
  });

  it("stays refused on a cancelled order, an invoiced order the shop never completed, and a pickup job", async () => {
    const cancelled = await workOrder();
    await must(admin.from("work_orders").update({ status: "cancelled" }).eq("id", cancelled.id));
    const notCompleted = await workOrder();
    await must(admin.from("work_orders").update({ status: "invoiced", affiliate_invoice_ref: "SHOP-3" }).eq("id", notCompleted.id));
    const pickup = await invoicedBeforeCompletion("pickup");
    for (const wo of [cancelled, notCompleted, pickup]) {
      const { error } = await shop.client.rpc("shop_set_ship_status", { p_work_order: wo.id, p_status: "shipped" });
      expect(error?.message).toMatch(/Shipping status applies/);
    }
  });
});

describe("shop rate on an order invoiced before the shop completed it", () => {
  it("CDS can enter a TBD shop rate once, but not change it afterwards", async () => {
    const wo = await invoicedBeforeCompletion();
    expect(await rateOf(wo.line)).toBeNull();
    await must(cds.client.rpc("cds_set_line_shop_rate", { p_line: wo.line, p_amount: 18.5 }));
    expect(await rateOf(wo.line)).toBe(18.5);
    const again = await cds.client.rpc("cds_set_line_shop_rate", { p_line: wo.line, p_amount: 20 });
    expect(again.error?.message).toMatch(/invoiced/);
    expect(await rateOf(wo.line)).toBe(18.5);
  });

  it("is refused on a cancelled order and for a shop", async () => {
    const wo = await workOrder();
    expect((await shop.client.rpc("cds_set_line_shop_rate", { p_line: wo.line, p_amount: 5 })).error).not.toBeNull();
    await must(admin.from("work_orders").update({ status: "cancelled" }).eq("id", wo.id));
    expect((await cds.client.rpc("cds_set_line_shop_rate", { p_line: wo.line, p_amount: 5 })).error?.message).toMatch(/cancelled/);
    expect(await rateOf(wo.line)).toBeNull();
  });
});
