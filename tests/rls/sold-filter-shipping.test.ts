/**
 * Shipping on orders that sell a filter and record no components (Sarah, CDS, 2026-11-18:
 * "the shipping credit is not showing up on affiliate bills where there are no components
 * added (like where a filter is sold)"), and the GESi shipping item (Sarah, 2026-11-18).
 *
 * 20261119120000_customer_shipping_charge.sql (customer side) and
 * 20261119140000_shipping_deduction_sold_filters.sql (shop side):
 *   * a shipped order (fulfillment 'shipping', or 'supplier_direct': the supplier ships the
 *     part to the customer) with no components recorded by its shop counts the filters sold
 *     on it: lines whose SKU is a reconditioned or new filter (CDS-RECON-DPF/DOC/SCR,
 *     CDS-NEW-FILTER) or a GESi filter (CDS-DPF/DOC/SCR-GESI...);
 *   * the shop gets the $15 credit per filter sold, GESi included (never the in-house shop);
 *   * the customer pays $28 per filter sold in the Shipping box, except GESi filters: those
 *     are charged on the "Shipping & Handling Fee (G)" item, $28 each, $150 each when the order
 *     has an overnight label; First Student is not charged, CDS's override wins;
 *   * an order with components keeps today's count (components only);
 *   * an order whose shop bill (or customer invoice) is already in QuickBooks keeps what it had.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Row = { id: string };

async function insertOne<T extends Row>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const f = {} as {
  shop: string;
  inHouse: string;
  customer: string;
  noShipCustomer: string;
  recon: string;
  newFilter: string;
  gesi: string;
  sensor: string;
};
let cds: Login;
let shop: Login;

async function item(sku: string): Promise<string> {
  const id = (await insertOne("catalog_items", { sku, category: "part", name: `Test ${sku}`, tax_class: "parts" })).id;
  await must(admin.from("shop_rates").insert({ catalog_item_id: id, amount: 500, effective_from: "2026-01-01" }));
  await must(admin.from("sell_prices").insert({ catalog_item_id: id, amount: 900, effective_from: "2026-01-01" }));
  return id;
}

beforeAll(async () => {
  f.shop = (await insertOne("affiliates", { short_code: `SFS-${runId}`, display_name: `Shop SFS ${runId}` })).id;
  f.inHouse = (await must(admin.from("affiliates").select("id").eq("is_in_house", true).single())).id;
  f.customer = (await insertOne("customers", { code: `SFC-${runId}`, name: `Sold filter customer ${runId}` })).id;
  f.noShipCustomer = (await insertOne("customers", { code: `SFN-${runId}`, name: `Sold filter no shipping ${runId}` })).id;
  await must(admin.from("customer_billing").insert({ customer_id: f.noShipCustomer, charge_shipping: false }));
  f.recon = await item(`CDS-RECON-DPF-${runId}`);
  f.newFilter = await item(`CDS-NEW-FILTER-${runId}`);
  f.gesi = await item(`CDS-DPF-GESI${runId}`);
  f.sensor = await item(`ENV-NOX-${runId}`);
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", f.shop);
});

afterAll(async () => {
  await deleteLogins();
  await must(admin.from("work_orders").delete().in("customer_id", [f.customer, f.noShipCustomer]));
  await must(admin.from("catalog_items").delete().in("id", [f.recon, f.newFilter, f.gesi, f.sensor]));
  await must(admin.from("customers").delete().in("id", [f.customer, f.noShipCustomer]));
  await must(admin.from("affiliates").delete().eq("id", f.shop));
});

let unit = 0;
async function newWo(opts: { shop?: string; fulfillment?: string; customer?: string } = {}): Promise<string> {
  unit += 1;
  const fulfillment = opts.fulfillment ?? "shipping";
  const wo = await insertOne<Row>("work_orders", {
    customer_id: opts.customer ?? f.customer,
    location_label: `TEST-${runId}`,
    request_type: "parts_only",
    fulfillment,
    affiliate_id: opts.shop ?? f.shop,
    status: "accepted",
    pickup_window: fulfillment === "pickup" ? "08-10" : null,
    unit_number: `SF-${unit}`,
    requested_work: "Test sold filter shipping",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

async function addLine(wo: string, itemId: string, qty = 1): Promise<void> {
  await must(cds.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: itemId, qty }));
}

let seq = 0;
async function addComponents(wo: string, types: string[]): Promise<void> {
  await must(admin.from("work_order_components").insert(types.map((t) => ({ work_order_id: wo, seq: ++seq, component_type: t }))));
}

let labels = 0;
async function addLabel(wo: string, serviceCode: string, over: Record<string, unknown> = {}): Promise<string> {
  labels += 1;
  const s = await insertOne<Row>("shipments", { work_order_id: wo, direction: "supplier_to_customer", carrier: "FedEx" });
  const label = await insertOne<Row>("shipment_labels", {
    shipment_id: s.id,
    work_order_id: wo,
    shipstation_label_id: `se-${runId}-sf${labels}`,
    shipstation_carrier_id: "se-7157832",
    carrier: "FedEx",
    service_code: serviceCode,
    is_test: false,
    ship_from_summary: "Test",
    ...over,
  });
  return label.id;
}

const deduction = async (wo: string, login: Login = cds) => {
  const rows = await must(login.client.from("work_order_shop_deductions").select("filters, amount").eq("work_order_id", wo));
  return rows.length ? { filters: rows[0].filters, amount: Number(rows[0].amount) } : null;
};

type Shipping = {
  counted_from: string | null;
  filters: number;
  gesi_filters: number;
  overnight: boolean;
  box_amount: number;
  gesi_amount: number;
  gesi_unit_amount: number;
  amount: number;
};
const shipping = async (wo: string): Promise<Shipping> => {
  const r = await must(
    cds.client
      .from("work_order_customer_shipping")
      .select("counted_from, filters, gesi_filters, overnight, box_amount, gesi_amount, gesi_unit_amount, amount")
      .eq("work_order_id", wo)
      .single(),
  );
  return {
    counted_from: r.counted_from,
    filters: r.filters,
    gesi_filters: r.gesi_filters,
    overnight: r.overnight,
    box_amount: Number(r.box_amount),
    gesi_amount: Number(r.gesi_amount),
    gesi_unit_amount: Number(r.gesi_unit_amount),
    amount: Number(r.amount),
  };
};

describe("a shipped order that sells a filter and records no components", () => {
  // The client report: a shipped parts-only order with 1 CDS-RECON-DPF and no components.
  it("gets the $15 shop credit and the customer's $28 for 1 CDS-RECON-DPF", async () => {
    const wo = await newWo();
    await addLine(wo, f.recon);
    expect(await deduction(wo)).toEqual({ filters: 1, amount: -15 });
    expect(await deduction(wo, shop)).toEqual({ filters: 1, amount: -15 });
    expect(await shipping(wo)).toMatchObject({ counted_from: "sold", filters: 1, gesi_filters: 0, box_amount: 28, gesi_amount: 0, amount: 28 });
  });

  it("counts the quantity of every filter sold, not other parts", async () => {
    const wo = await newWo({ fulfillment: "supplier_direct" });
    await addLine(wo, f.recon, 2);
    await addLine(wo, f.newFilter);
    await addLine(wo, f.sensor, 3);
    expect(await deduction(wo)).toEqual({ filters: 3, amount: -45 });
    expect(await shipping(wo)).toMatchObject({ filters: 3, box_amount: 84, amount: 84 });
  });

  it("gets nothing on a pickup order", async () => {
    const wo = await newWo({ fulfillment: "pickup" });
    await addLine(wo, f.recon);
    expect(await deduction(wo)).toBeNull();
    expect(await shipping(wo)).toMatchObject({ filters: 0, amount: 0 });
  });

  it("keeps today's count when the order has components", async () => {
    const wo = await newWo();
    await addLine(wo, f.recon, 2);
    await addComponents(wo, ["DPF"]);
    expect(await deduction(wo)).toEqual({ filters: 1, amount: -15 });
    expect(await shipping(wo)).toMatchObject({ counted_from: "components", filters: 1, box_amount: 28 });
  });

  it("keeps a supplier direct order with components at no credit, as today", async () => {
    const wo = await newWo({ fulfillment: "supplier_direct" });
    await addLine(wo, f.recon);
    await addComponents(wo, ["DPF"]);
    expect(await deduction(wo)).toBeNull();
    expect(await shipping(wo)).toMatchObject({ filters: 0, box_amount: 0 });
  });

  it("is not changed once the shop's bill is in QuickBooks", async () => {
    const wo = await newWo();
    await addLine(wo, f.recon);
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: wo, status: "created", qb_bill_id: `SFB${runId}${unit}` }));
    expect(await deduction(wo)).toBeNull();
    expect(await deduction(wo, shop)).toBeNull();
  });

  it("is not changed once the customer invoice is in QuickBooks", async () => {
    const wo = await newWo();
    await addLine(wo, f.recon);
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo, p_qb_invoice_id: `SFI${runId}${unit}`, p_qb_invoice_number: null }));
    expect(await shipping(wo)).toMatchObject({ filters: 0, amount: 0 });
  });
});

describe("a GESi filter sold", () => {
  it("gives the shop the $15 credit and the customer a $28 Shipping & Handling Fee (G) charge, not the box", async () => {
    const wo = await newWo();
    await addLine(wo, f.gesi);
    expect(await deduction(wo)).toEqual({ filters: 1, amount: -15 });
    expect(await shipping(wo)).toMatchObject({
      filters: 0,
      gesi_filters: 1,
      overnight: false,
      box_amount: 0,
      gesi_unit_amount: 28,
      gesi_amount: 28,
      amount: 28,
    });
  });

  it("is $150 per GESi filter when the order has an overnight label, $28 when that label is voided", async () => {
    const wo = await newWo({ shop: f.inHouse });
    await addLine(wo, f.gesi, 2);
    const label = await addLabel(wo, "fedex_priority_overnight");
    expect(await shipping(wo)).toMatchObject({ gesi_filters: 2, overnight: true, gesi_unit_amount: 150, gesi_amount: 300, amount: 300 });
    // CDS's own shop gets no credit.
    expect(await deduction(wo)).toBeNull();
    await must(admin.from("shipment_labels").update({ status: "voided" }).eq("id", label));
    expect(await shipping(wo)).toMatchObject({ overnight: false, gesi_amount: 56 });
    await addLabel(wo, "wwex_ups_next_day_air");
    expect(await shipping(wo)).toMatchObject({ overnight: true, gesi_amount: 300 });
  });

  it("does not count a ground label or a test label as overnight", async () => {
    const wo = await newWo();
    await addLine(wo, f.gesi);
    await addLabel(wo, "fedex_ground");
    await addLabel(wo, "fedex_standard_overnight", { is_test: true });
    expect(await shipping(wo)).toMatchObject({ overnight: false, gesi_amount: 28 });
  });

  it("is charged next to the box when the order also cleans a shipped filter", async () => {
    const wo = await newWo();
    await addLine(wo, f.gesi);
    await addComponents(wo, ["DPF"]);
    expect(await shipping(wo)).toMatchObject({ counted_from: "components", filters: 1, box_amount: 28, gesi_filters: 1, gesi_amount: 28, amount: 56 });
  });

  it("is not charged to a customer with charge_shipping false (First Student)", async () => {
    const wo = await newWo({ customer: f.noShipCustomer });
    await addLine(wo, f.gesi);
    expect(await shipping(wo)).toMatchObject({ gesi_filters: 1, gesi_amount: 0, amount: 0 });
    expect(await deduction(wo)).toEqual({ filters: 1, amount: -15 });
  });

  it("takes CDS's override on the GESi line", async () => {
    const wo = await newWo();
    await addLine(wo, f.gesi);
    await addComponents(wo, ["DPF"]);
    await must(cds.client.from("work_order_internal").update({ customer_shipping_override: 150 }).eq("work_order_id", wo));
    expect(await shipping(wo)).toMatchObject({ box_amount: 0, gesi_amount: 150, amount: 150 });
  });

  it("follows the GESi rates in app_settings", async () => {
    const saved = (await must(admin.from("app_settings").select("value").eq("key", "customer_shipping_rates").single())).value;
    expect(saved).toMatchObject({ gesi_filter: 28, gesi_overnight: 150 });
    const wo = await newWo();
    await addLine(wo, f.gesi);
    try {
      await must(admin.from("app_settings").update({ value: { ...saved, gesi_filter: 30 } }).eq("key", "customer_shipping_rates"));
      expect(await shipping(wo)).toMatchObject({ gesi_amount: 30 });
    } finally {
      await must(admin.from("app_settings").update({ value: saved }).eq("key", "customer_shipping_rates"));
    }
  });
});
