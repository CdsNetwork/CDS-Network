/**
 * "Shipping credit from shop" per order (Sarah, CDS, 2026-11-19): NOx sensor orders entered as
 * Service, where the shop recorded a DPF to get past the measurements, got the $15 shipping
 * credit on the shop's bill although the shop gives none. CDS can now turn the credit off (or
 * back on) on any order (20261119210000_shop_shipping_credit_toggle.sql):
 *   * work_order_internal.shop_shipping_credit, true by default, CDS only (shops can neither
 *     read nor change it);
 *   * when false, public.work_order_shop_deductions has no row for the order, for CDS and for
 *     the shop, so the shop's bill and work_order_financials lose the credit;
 *   * the customer shipping charge (public.work_order_customer_shipping) does not change;
 *   * it cannot change once the shop's bill is in QuickBooks, nor while it is being created.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Row = { id: string };

async function insertOne<T extends Row>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const f = {} as { shop: string; customer: string; item: string };
let cds: Login;
let shop: Login;

beforeAll(async () => {
  f.shop = (await insertOne("affiliates", { short_code: `SCT-${runId}`, display_name: `Shop SCT ${runId}` })).id;
  f.customer = (await insertOne("customers", { code: `SCT-${runId}`, name: `Credit toggle customer ${runId}` })).id;
  f.item = (
    await insertOne("catalog_items", { sku: `SVC-SCT-${runId}`, category: "service", name: "Test NOx sensor service", tax_class: "labor" })
  ).id;
  await must(admin.from("shop_rates").insert({ catalog_item_id: f.item, amount: 100, effective_from: "2026-01-01" }));
  await must(admin.from("sell_prices").insert({ catalog_item_id: f.item, amount: 300, effective_from: "2026-01-01" }));
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", f.shop);
});

afterAll(async () => {
  await deleteLogins();
  await must(admin.from("work_orders").delete().eq("customer_id", f.customer));
  await must(admin.from("catalog_items").delete().eq("id", f.item));
  await must(admin.from("customers").delete().eq("id", f.customer));
  await must(admin.from("affiliates").delete().eq("id", f.shop));
});

let unit = 0;
let seq = 0;
/** A shipped Service order with one DPF component recorded: today it gets the $15 credit. */
async function newWo(): Promise<string> {
  unit += 1;
  const wo = await insertOne<Row>("work_orders", {
    customer_id: f.customer,
    location_label: `TEST-${runId}`,
    fulfillment: "shipping",
    affiliate_id: f.shop,
    status: "accepted",
    unit_number: `SCT-${unit}`,
    requested_work: "Test NOx sensor",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  await must(cds.client.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.item, qty: 1 }));
  await must(admin.from("work_order_components").insert({ work_order_id: wo.id, seq: ++seq, component_type: "DPF" }));
  return wo.id;
}

const deduction = async (wo: string, login: Login = cds) => {
  const rows = await must(login.client.from("work_order_shop_deductions").select("filters, amount").eq("work_order_id", wo));
  return rows.length ? { filters: rows[0].filters, amount: Number(rows[0].amount) } : null;
};

const flag = async (wo: string): Promise<boolean> =>
  (await must(admin.from("work_order_internal").select("shop_shipping_credit").eq("work_order_id", wo).single())).shop_shipping_credit;

const setFlag = (wo: string, value: boolean, login: Login = cds) =>
  login.client.from("work_order_internal").update({ shop_shipping_credit: value }).eq("work_order_id", wo).select("work_order_id");

const shopSubtotal = async (wo: string) =>
  Number((await must(cds.client.from("work_order_financials").select("shop_subtotal").eq("work_order_id", wo).single())).shop_subtotal);

const customerShipping = async (wo: string) =>
  Number((await must(cds.client.from("work_order_customer_shipping").select("amount").eq("work_order_id", wo).single())).amount);

describe("shipping credit from shop", () => {
  it("is on by default and gives the $15 credit, as today", async () => {
    const wo = await newWo();
    expect(await flag(wo)).toBe(true);
    expect(await deduction(wo)).toEqual({ filters: 1, amount: -15 });
    expect(await deduction(wo, shop)).toEqual({ filters: 1, amount: -15 });
  });

  it("turned off by CDS removes the credit for CDS, the shop and the financials, and back on restores it", async () => {
    const wo = await newWo();
    expect(await shopSubtotal(wo)).toBe(85);
    const off = await must(setFlag(wo, false));
    expect(off).toHaveLength(1);
    expect(await deduction(wo)).toBeNull();
    expect(await deduction(wo, shop)).toBeNull();
    expect(await shopSubtotal(wo)).toBe(100);
    await must(setFlag(wo, true));
    expect(await deduction(wo)).toEqual({ filters: 1, amount: -15 });
    expect(await shopSubtotal(wo)).toBe(85);
  });

  it("does not change the customer shipping charge", async () => {
    const wo = await newWo();
    const before = await customerShipping(wo);
    expect(before).toBe(28);
    await must(setFlag(wo, false));
    expect(await customerShipping(wo)).toBe(before);
  });

  it("cannot be read or changed by a shop", async () => {
    const wo = await newWo();
    const read = await shop.client.from("work_order_internal").select("shop_shipping_credit").eq("work_order_id", wo);
    expect(read.data ?? []).toEqual([]);
    const res = await setFlag(wo, false, shop);
    expect(res.data ?? []).toEqual([]);
    expect(await flag(wo)).toBe(true);
    expect(await deduction(wo, shop)).toEqual({ filters: 1, amount: -15 });
  });

  it("is never null", async () => {
    const wo = await newWo();
    const res = await cds.client.from("work_order_internal").update({ shop_shipping_credit: null }).eq("work_order_id", wo);
    expect(res.error).not.toBeNull();
  });

  it("cannot change once the shop's bill is in QuickBooks (qbo_shop_bills)", async () => {
    const wo = await newWo();
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: wo, status: "created", qb_bill_id: `SCTB${runId}${unit}` }));
    const res = await setFlag(wo, false);
    expect(res.error?.message).toMatch(/shop's bill is in QuickBooks/);
    expect(await flag(wo)).toBe(true);
    expect(await deduction(wo)).toEqual({ filters: 1, amount: -15 });
  });

  it("cannot change once the bill id is on the order (work_order_internal.qb_bill_id)", async () => {
    const wo = await newWo();
    await must(setFlag(wo, false));
    await must(admin.from("work_order_internal").update({ qb_bill_id: `SCTI${runId}${unit}` }).eq("work_order_id", wo));
    const res = await setFlag(wo, true);
    expect(res.error?.message).toMatch(/shop's bill is in QuickBooks/);
    expect(await flag(wo)).toBe(false);
    expect(await deduction(wo)).toBeNull();
  });

  it("cannot change while the shop's bill is being created, and can after a failed attempt", async () => {
    const wo = await newWo();
    await must(
      admin.from("qbo_shop_bills").insert({ work_order_id: wo, status: "creating", claim_id: crypto.randomUUID(), claimed_at: new Date().toISOString() }),
    );
    const res = await setFlag(wo, false);
    expect(res.error?.message).toMatch(/being created/);
    expect(await flag(wo)).toBe(true);
    await must(admin.from("qbo_shop_bills").update({ status: "failed", error: "Test failure" }).eq("work_order_id", wo));
    await must(setFlag(wo, false));
    expect(await flag(wo)).toBe(false);
  });
});
