/**
 * Automatic shipping charge on the customer's QuickBooks invoice
 * (20261119120000_customer_shipping_charge.sql, CDS 2026-11-18).
 *
 * public.work_order_customer_shipping: on a shipped order, $28 per filter (DPF, DOC, SCR) and
 * $34 per EGR cooler, the same parts the shop's shipping deduction counts. Not on pickup or
 * supplier direct orders, not for the in-house shop, not for a customer with
 * charge_shipping false. CDS can override it per order (work_order_internal), never after
 * the order is invoiced. Shops never see it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Row = { id: string };

async function insertOne<T extends Row>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const f = {} as { shopA: string; shopB: string; inHouse: string; customer: string; noShipCustomer: string };
let cds: Login;
let shopA: Login;
let savedRates: unknown;

beforeAll(async () => {
  f.shopA = (await insertOne("affiliates", { short_code: `CSA-${runId}`, display_name: `Shop CSA ${runId}` })).id;
  f.shopB = (await insertOne("affiliates", { short_code: `CSB-${runId}`, display_name: `Shop CSB ${runId}` })).id;
  f.inHouse = (await must(admin.from("affiliates").select("id").eq("is_in_house", true).single())).id;
  f.customer = (await insertOne("customers", { code: `CSC-${runId}`, name: `Shipping customer ${runId}` })).id;
  f.noShipCustomer = (await insertOne("customers", { code: `CSN-${runId}`, name: `No shipping customer ${runId}` })).id;
  await must(admin.from("customer_billing").insert({ customer_id: f.noShipCustomer, charge_shipping: false }));
  savedRates = (await must(admin.from("app_settings").select("value").eq("key", "customer_shipping_rates").maybeSingle()))?.value ?? null;
  cds = await createLogin("cds", null);
  shopA = await createLogin("shop", f.shopA);
});

afterAll(async () => {
  await deleteLogins();
  if (savedRates !== null) {
    await must(admin.from("app_settings").update({ value: savedRates }).eq("key", "customer_shipping_rates"));
  }
  await must(admin.from("work_orders").delete().in("customer_id", [f.customer, f.noShipCustomer]));
  await must(admin.from("customers").delete().in("id", [f.customer, f.noShipCustomer]));
  await must(admin.from("affiliates").delete().in("id", [f.shopA, f.shopB]));
});

let unit = 0;
async function newWo(opts: { shop?: string | null; fulfillment?: string; customer?: string; status?: string } = {}): Promise<string> {
  unit += 1;
  const fulfillment = opts.fulfillment ?? "shipping";
  const wo = await insertOne<Row>("work_orders", {
    customer_id: opts.customer ?? f.customer,
    location_label: `TEST-${runId}`,
    fulfillment,
    affiliate_id: opts.shop === undefined ? f.shopA : opts.shop,
    status: opts.status ?? "accepted",
    pickup_window: fulfillment === "pickup" ? "08-10" : null,
    unit_number: `CS-${unit}`,
    requested_work: "Test customer shipping",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

let seq = 0;
async function addComponents(wo: string, types: string[], affiliateId?: string): Promise<void> {
  const rows = types.map((t) => ({ work_order_id: wo, seq: ++seq, component_type: t, ...(affiliateId ? { affiliate_id: affiliateId } : {}) }));
  await must(admin.from("work_order_components").insert(rows));
}

type Shipping = { filters: number; egr_coolers: number; automatic_amount: number; override_amount: number | null; amount: number; charge_shipping: boolean };
const shipping = async (wo: string, login: Login = cds): Promise<Shipping | null> => {
  const rows = await must(
    login.client
      .from("work_order_customer_shipping")
      .select("filters, egr_coolers, automatic_amount, override_amount, amount, charge_shipping")
      .eq("work_order_id", wo),
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    filters: r.filters,
    egr_coolers: r.egr_coolers,
    automatic_amount: Number(r.automatic_amount),
    override_amount: r.override_amount === null ? null : Number(r.override_amount),
    amount: Number(r.amount),
    charge_shipping: r.charge_shipping,
  };
};
const amount = async (wo: string) => (await shipping(wo))?.amount;

describe("customer shipping charge", () => {
  it("is $28 per filter: a DPF and a DOC on one shipped order = $56", async () => {
    const wo = await newWo();
    await addComponents(wo, ["DPF", "DOC"]);
    expect(await shipping(wo)).toEqual({ filters: 2, egr_coolers: 0, automatic_amount: 56, override_amount: null, amount: 56, charge_shipping: true });
  });

  it("is $34 per EGR cooler and $28 per DPF, DOC or SCR", async () => {
    const wo = await newWo();
    await addComponents(wo, ["DPF", "SCR", "EGR"]);
    expect(await shipping(wo)).toMatchObject({ filters: 2, egr_coolers: 1, amount: 90 });
  });

  it("is 0 on pickup, supplier direct and unspecified orders", async () => {
    for (const fulfillment of ["pickup", "supplier_direct", "unspecified"]) {
      const wo = await newWo({ fulfillment });
      await addComponents(wo, ["DPF", "EGR"]);
      expect(await amount(wo), fulfillment).toBe(0);
    }
  });

  // Unlike the shop deduction (CDS does not credit itself), the customer pays shipping when
  // CDS's in-house shop cleans a shipped filter (CDS, 2026-11-18).
  it("is charged when CDS's in-house shop does the work: a DPF and a DOC shipped = $56", async () => {
    const inHouse = await newWo({ shop: f.inHouse });
    await addComponents(inHouse, ["DPF", "DOC"]);
    expect(await shipping(inHouse)).toMatchObject({ filters: 2, egr_coolers: 0, amount: 56 });
  });

  it("is 0 for an order without a shop yet", async () => {
    const noShop = await newWo({ shop: null, status: "pending_review" });
    await addComponents(noShop, ["DPF"]);
    expect(await amount(noShop)).toBe(0);
  });

  it("counts only the parts of the order's current shop (or of no shop), as the shop deduction does", async () => {
    const wo = await newWo();
    await addComponents(wo, ["DPF"], f.shopA);
    await addComponents(wo, ["DOC"], f.shopB);
    await addComponents(wo, ["SCR"]);
    expect(await shipping(wo)).toMatchObject({ filters: 2, amount: 56 });
    const deduction = await must(cds.client.from("work_order_shop_deductions").select("filters").eq("work_order_id", wo));
    expect(deduction).toEqual([{ filters: 2 }]);
  });

  it("is 0 for a customer that is not charged shipping", async () => {
    const wo = await newWo({ customer: f.noShipCustomer });
    await addComponents(wo, ["DPF", "DOC"]);
    expect(await shipping(wo)).toMatchObject({ charge_shipping: false, automatic_amount: 0, amount: 0 });
  });

  it("is charged by default for a new customer", async () => {
    const billing = await must(admin.from("customer_billing").insert({ customer_id: f.customer }).select("charge_shipping").single());
    expect(billing.charge_shipping).toBe(true);
  });

  it("is not charged to First Student customers", async () => {
    const rows = await must(admin.from("customers").select("id, customer_billing(charge_shipping)").ilike("name", "First Student%"));
    for (const r of rows as { id: string; customer_billing: { charge_shipping: boolean } | { charge_shipping: boolean }[] | null }[]) {
      const b = Array.isArray(r.customer_billing) ? r.customer_billing[0] : r.customer_billing;
      expect(b?.charge_shipping, r.id).toBe(false);
    }
  });

  it("follows the rates in app_settings", async () => {
    const wo = await newWo();
    await addComponents(wo, ["DPF", "EGR"]);
    await must(admin.from("app_settings").upsert({ key: "customer_shipping_rates", value: { filter: 30, egr_cooler: 40 } }, { onConflict: "key" }));
    expect(await amount(wo)).toBe(70);
    await must(admin.from("app_settings").update({ value: { filter: 28, egr_cooler: 34 } }).eq("key", "customer_shipping_rates"));
    expect(await amount(wo)).toBe(62);
  });

  it("takes CDS's override (an amount or 0) and goes back to automatic", async () => {
    const wo = await newWo();
    await addComponents(wo, ["DPF"]);
    await must(cds.client.from("work_order_internal").update({ customer_shipping_override: 45.5 }).eq("work_order_id", wo));
    expect(await shipping(wo)).toMatchObject({ automatic_amount: 28, override_amount: 45.5, amount: 45.5 });
    await must(cds.client.from("work_order_internal").update({ customer_shipping_override: 0 }).eq("work_order_id", wo));
    expect(await amount(wo)).toBe(0);
    await must(cds.client.from("work_order_internal").update({ customer_shipping_override: null }).eq("work_order_id", wo));
    expect(await amount(wo)).toBe(28);
  });

  it("refuses a negative override", async () => {
    const wo = await newWo();
    const { error } = await cds.client.from("work_order_internal").update({ customer_shipping_override: -1 }).eq("work_order_id", wo);
    expect(error).not.toBeNull();
  });

  it("cannot be overridden once the order has a QuickBooks invoice", async () => {
    const wo = await newWo({ status: "in_process" });
    await addComponents(wo, ["DPF"]);
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo, p_qb_invoice_id: `CS${runId}${unit}`, p_qb_invoice_number: null }));
    const { error } = await cds.client.from("work_order_internal").update({ customer_shipping_override: 0 }).eq("work_order_id", wo);
    expect(error?.message).toMatch(/shipping charge cannot change after the order is invoiced/);
  });

  it("is locked with the other invoice inputs while the invoice is being created", async () => {
    const wo = await newWo({ status: "in_process" });
    await addComponents(wo, ["DPF"]);
    await must(cds.client.rpc("cds_claim_qbo_invoice", { p_work_order: wo, p_snapshot: "s1" }));
    const override = await cds.client.from("work_order_internal").update({ customer_shipping_override: 0 }).eq("work_order_id", wo);
    expect(override.error?.message).toMatch(/being created in QuickBooks/);
    const fulfillment = await cds.client.from("work_orders").update({ fulfillment: "pickup", pickup_window: "08-10" }).eq("id", wo);
    expect(fulfillment.error?.message).toMatch(/being created in QuickBooks/);
  });

  it("is never visible to a shop", async () => {
    const wo = await newWo();
    await addComponents(wo, ["DPF"]);
    expect(await shipping(wo, shopA)).toBeNull();
    const internal = await shopA.client.from("work_order_internal").select("customer_shipping_override").eq("work_order_id", wo);
    expect(internal.data ?? []).toEqual([]);
    const billing = await shopA.client.from("customer_billing").select("charge_shipping").eq("customer_id", f.customer);
    expect(billing.data ?? []).toEqual([]);
  });
});
