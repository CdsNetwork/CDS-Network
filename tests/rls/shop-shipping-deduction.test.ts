/**
 * The $15 per filter shared shipping deduction on the shop's bill
 * (20261111030000_shop_filter_shipping_deduction.sql).
 *
 * On a shipped order the shop's bill gets one deduction: minus $15 per filter (DPF, DOC and
 * SCR components the order's shop recorded; EGR coolers are not filters). Pickup orders and
 * the in-house shop get nothing. It is computed, so it follows the fulfillment method and
 * the filter count, and it never touches the customer side.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Row = { id: string };

async function insertOne<T extends Row>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const f = {} as { shopA: string; shopB: string; inHouse: string; customer: string; item: string };
let cds: Login;
let shopA: Login;
let shopB: Login;

beforeAll(async () => {
  f.shopA = (await insertOne("affiliates", { short_code: `SDA-${runId}`, display_name: `Shop SDA ${runId}` })).id;
  f.shopB = (await insertOne("affiliates", { short_code: `SDB-${runId}`, display_name: `Shop SDB ${runId}` })).id;
  f.inHouse = (await must(admin.from("affiliates").select("id").eq("is_in_house", true).single())).id;
  f.customer = (await insertOne("customers", { code: `SDC-${runId}`, name: `Deduction customer ${runId}` })).id;
  f.item = (
    await insertOne("catalog_items", { sku: `SVC-SD-${runId}`, category: "service", name: "Test DPF cleaning", tax_class: "labor" })
  ).id;
  await must(admin.from("shop_rates").insert({ catalog_item_id: f.item, amount: 100, effective_from: "2026-01-01" }));
  await must(admin.from("sell_prices").insert({ catalog_item_id: f.item, amount: 300, effective_from: "2026-01-01" }));
  cds = await createLogin("cds", null);
  shopA = await createLogin("shop", f.shopA);
  shopB = await createLogin("shop", f.shopB);
});

afterAll(async () => {
  await deleteLogins();
  await must(admin.from("work_orders").delete().eq("customer_id", f.customer));
  await must(admin.from("catalog_items").delete().eq("id", f.item));
  await must(admin.from("customers").delete().eq("id", f.customer));
  await must(admin.from("affiliates").delete().in("id", [f.shopA, f.shopB]));
});

let unit = 0;
async function newWo(shop: string, fulfillment = "shipping"): Promise<string> {
  unit += 1;
  const wo = await insertOne<Row>("work_orders", {
    customer_id: f.customer,
    location_label: `TEST-${runId}`,
    fulfillment,
    affiliate_id: shop,
    status: "accepted",
    pickup_window: fulfillment === "pickup" ? "08-10" : null,
    unit_number: `SD-${unit}`,
    requested_work: "Test deduction",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  // Lines are added as CDS, so the shop rate and the customer price are snapshotted.
  await must(cds.client.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.item, qty: 1 }));
  return wo.id;
}

let seq = 0;
async function addComponents(wo: string, types: string[], affiliateId?: string): Promise<string[]> {
  const rows = types.map((t) => ({
    work_order_id: wo,
    seq: ++seq,
    component_type: t,
    ...(affiliateId ? { affiliate_id: affiliateId } : {}),
  }));
  return (await must(admin.from("work_order_components").insert(rows).select("id"))).map((r: Row) => r.id);
}

const deductions = (login: Login, wo: string) =>
  must(login.client.from("work_order_shop_deductions").select("kind, filters, unit_amount, amount").eq("work_order_id", wo));

const financials = async (wo: string) =>
  must(
    cds.client
      .from("work_order_financials")
      .select("customer_subtotal, shop_subtotal, margin_before_shipping, shop_deductions")
      .eq("work_order_id", wo)
      .single(),
  );

describe("shared shipping deduction", () => {
  it("is minus $15 per DPF, DOC and SCR on a shipped order; EGR coolers are not filters", async () => {
    const wo = await newWo(f.shopA);
    await addComponents(wo, ["DPF", "DPF", "DOC", "EGR"]);
    expect(await deductions(cds, wo)).toEqual([{ kind: "filter_shipping", filters: 3, unit_amount: -15, amount: -45 }]);
  });

  it("is in the shop subtotal and the margin, and leaves the customer subtotal alone", async () => {
    const wo = await newWo(f.shopA);
    await addComponents(wo, ["DPF", "SCR"]);
    const fin = await financials(wo);
    expect(Number(fin.customer_subtotal)).toBe(300);
    expect(Number(fin.shop_subtotal)).toBe(70);
    expect(Number(fin.shop_deductions)).toBe(-30);
    expect(Number(fin.margin_before_shipping)).toBe(230);
    // Not a line: no customer price, nothing for the invoice.
    const lines = await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo));
    const priced = await must(admin.from("work_order_line_pricing").select("line_id").eq("work_order_id", wo));
    expect(lines.length).toBe(1);
    expect(priced.length).toBe(1);
  });

  it("is applied once, however often it is read", async () => {
    const wo = await newWo(f.shopA);
    await addComponents(wo, ["DPF"]);
    expect((await deductions(cds, wo)).length).toBe(1);
    expect(Number((await financials(wo)).shop_subtotal)).toBe(85);
    expect(Number((await financials(wo)).shop_subtotal)).toBe(85);
  });

  it("follows the filter count", async () => {
    const wo = await newWo(f.shopA);
    expect(await deductions(cds, wo)).toEqual([]);
    const [first] = await addComponents(wo, ["DPF"]);
    expect((await deductions(cds, wo))[0].amount).toBe(-15);
    await addComponents(wo, ["DOC"]);
    expect((await deductions(cds, wo))[0].amount).toBe(-30);
    await must(admin.from("work_order_components").delete().eq("id", first));
    expect((await deductions(cds, wo))[0].amount).toBe(-15);
  });

  it("follows the fulfillment method: none on pickup, back when shipped again", async () => {
    const wo = await newWo(f.shopA);
    await addComponents(wo, ["DPF", "DOC"]);
    await must(admin.from("work_orders").update({ fulfillment: "pickup", pickup_window: "08-10" }).eq("id", wo));
    expect(await deductions(cds, wo)).toEqual([]);
    expect(Number((await financials(wo)).shop_subtotal)).toBe(100);
    await must(admin.from("work_orders").update({ fulfillment: "shipping" }).eq("id", wo));
    expect((await deductions(cds, wo))[0].amount).toBe(-30);
  });

  it("is never on a pickup order", async () => {
    const wo = await newWo(f.shopA, "pickup");
    await addComponents(wo, ["DPF", "DOC"]);
    expect(await deductions(cds, wo)).toEqual([]);
  });

  it("is never on an in-house (CDS-IN-HOUSE) order", async () => {
    const wo = await insertOne<Row>("work_orders", {
      customer_id: f.customer,
      location_label: `TEST-${runId}`,
      fulfillment: "shipping",
      affiliate_id: f.inHouse,
      status: "accepted",
      unit_number: "SD-IH",
      requested_work: "Test deduction in-house",
    });
    await addComponents(wo.id, ["DPF", "DOC"]);
    expect(await deductions(cds, wo.id)).toEqual([]);
  });

  it("counts only the filters of the order's current shop", async () => {
    const wo = await newWo(f.shopA);
    await addComponents(wo, ["DPF"]);
    await addComponents(wo, ["DPF", "DPF"], f.shopB);
    expect((await deductions(cds, wo))[0].filters).toBe(1);
  });

  it("the shop sees its own deduction; another shop sees none", async () => {
    const wo = await newWo(f.shopA);
    await addComponents(wo, ["DPF", "DOC"]);
    expect(await deductions(shopA, wo)).toEqual([{ kind: "filter_shipping", filters: 2, unit_amount: -15, amount: -30 }]);
    expect(await deductions(shopB, wo)).toEqual([]);
    // Shops still see no financials.
    expect(await must(shopA.client.from("work_order_financials").select("*").eq("work_order_id", wo))).toEqual([]);
  });
});
