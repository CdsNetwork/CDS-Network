/**
 * The customer subtotal and gross margin include the customer shipping charge (Sarah, CDS,
 * 2026-11-19: the work order showed "Customer subtotal $250.00" and "Gross margin -$15.40,
 * after $60.40 shipping cost" although the QuickBooks invoice also charged $28 shipping).
 *
 * public.work_order_financials (20261119230000_financials_customer_shipping.sql):
 *   * before the QuickBooks invoice: customer_subtotal = the lines + the customer shipping
 *     charge (public.work_order_customer_shipping.amount), margin = that - shop payable -
 *     shipping cost;
 *   * once the order has its own QuickBooks invoice with amounts: customer_subtotal = the
 *     invoice total - its tax (what QuickBooks charged before tax), so the page matches
 *     QuickBooks;
 *   * an invoice that covers two linked work orders: each keeps its own computed share, so
 *     the invoice is not counted twice.
 * Shops never read it.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 * Nothing here calls QuickBooks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `CRM-${runId}`;
const f = {} as { shop: string; shopB: string; customer: string; noShipCustomer: string; part: string };
let cds: Login;
let shop: Login;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

beforeAll(async () => {
  f.shop = (await insertOne("affiliates", { short_code: `CRA-${runId}`, display_name: `Revenue Shop A ${runId}` })).id;
  f.shopB = (await insertOne("affiliates", { short_code: `CRB-${runId}`, display_name: `Revenue Shop B ${runId}` })).id;
  f.customer = (await insertOne("customers", { code: `CRC-${runId}`, name: `Revenue Customer ${runId}` })).id;
  f.noShipCustomer = (await insertOne("customers", { code: `CRN-${runId}`, name: `Revenue No Shipping ${runId}` })).id;
  await must(admin.from("customer_billing").insert({ customer_id: f.noShipCustomer, charge_shipping: false }));
  // $250 to the customer, $220 to the shop: with the $15 shipping credit the shop is paid $205.
  f.part = (await insertOne("catalog_items", { sku: `CRP-${runId}`, category: "service", name: "Test cleaning", tax_class: "labor" })).id;
  await must(admin.from("sell_prices").insert({ catalog_item_id: f.part, market: "US", amount: 250, effective_from: "2026-01-01" }));
  await must(admin.from("shop_rates").insert({ catalog_item_id: f.part, market: "US", amount: 220, effective_from: "2026-01-01" }));
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", f.shop);
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("catalog_items").delete().like("sku", suffix);
  await admin.from("customers").delete().like("code", suffix);
  await admin.from("affiliates").delete().like("short_code", suffix);
}, 120_000);

let unit = 0;
/**
 * Sarah's order: a shipped DPF cleaning, $250 of lines, the shop paid $205 ($220 - $15
 * shipping credit), a $60.40 label, and the $28 customer shipping charge for the DPF.
 */
async function sarahsOrder(opts: { status?: string; shop?: string; customer?: string } = {}): Promise<string> {
  unit += 1;
  const wo = await insertOne<{ id: string }>("work_orders", {
    customer_id: opts.customer ?? f.customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: opts.shop ?? f.shop,
    status: opts.status ?? "in_process",
    unit_number: `CR-${unit}`,
    po_number: `PO-${runId}-${unit}`,
    requested_work: "Test DPF cleaning",
    affiliate_invoice_ref: `REF-${runId}-${unit}`,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.part, qty: 1, origin: "cds_order" }));
  await must(admin.from("work_order_components").insert({ work_order_id: wo.id, seq: 1, component_type: "DPF" }));
  const ship = await insertOne<{ id: string }>("shipments", { work_order_id: wo.id, direction: "customer_to_affiliate", carrier: "UPS" });
  await must(admin.from("shipment_internal").insert({ shipment_id: ship.id, actual_cost: 60.4 }));
  return wo.id;
}

type Fin = { customer_subtotal: number; shop_subtotal: number; shipping_cost: number; margin: number; customer_shipping: number; lines_subtotal: number; customer_from_invoice: boolean };
async function fin(wo: string, login: Login = cds): Promise<Fin | null> {
  const rows = await must(
    login.client
      .from("work_order_financials")
      .select("customer_subtotal, shop_subtotal, shipping_cost, margin, customer_shipping, lines_subtotal, customer_from_invoice")
      .eq("work_order_id", wo),
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    customer_subtotal: Number(r.customer_subtotal),
    shop_subtotal: Number(r.shop_subtotal),
    shipping_cost: Number(r.shipping_cost),
    margin: Number(r.margin),
    customer_shipping: Number(r.customer_shipping),
    lines_subtotal: Number(r.lines_subtotal),
    customer_from_invoice: r.customer_from_invoice === true,
  };
}

describe("work order financials with the customer shipping charge", () => {
  it("counts the $28 shipping charge: customer subtotal $278.00, margin $12.60 (not -$15.40)", async () => {
    const wo = await sarahsOrder();
    expect(await fin(wo)).toEqual({
      customer_subtotal: 278,
      shop_subtotal: 205,
      shipping_cost: 60.4,
      margin: 12.6,
      customer_shipping: 28,
      lines_subtotal: 250,
      customer_from_invoice: false,
    });
  });

  it("follows CDS's shipping override, and adds nothing for a customer not charged shipping", async () => {
    const wo = await sarahsOrder();
    await must(cds.client.from("work_order_internal").update({ customer_shipping_override: 40 }).eq("work_order_id", wo));
    expect(await fin(wo)).toMatchObject({ customer_subtotal: 290, margin: 24.6, customer_shipping: 40 });
    const noShip = await sarahsOrder({ customer: f.noShipCustomer });
    expect(await fin(noShip)).toMatchObject({ customer_subtotal: 250, margin: -15.4, customer_shipping: 0 });
  });

  it("uses the QuickBooks invoice's own amounts once the order is invoiced (total - tax)", async () => {
    const wo = await sarahsOrder({ status: "completed" });
    // QuickBooks charged $300 before tax (e.g. a line edited in QuickBooks) and $21 tax.
    await must(
      cds.client.rpc("cds_mark_invoiced", {
        p_work_order: wo,
        p_qb_invoice_id: `CRM${runId}a`,
        p_qb_invoice_number: `N${runId}a`,
        p_qb_tax_total: 21,
        p_qb_total: 321,
      }),
    );
    expect(await fin(wo)).toMatchObject({ customer_subtotal: 300, shop_subtotal: 205, margin: 34.6, customer_from_invoice: true });
  });

  it("keeps the computed amount for an invoice recorded without amounts", async () => {
    const wo = await sarahsOrder({ status: "completed" });
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo, p_qb_invoice_id: `CRM${runId}b`, p_qb_invoice_number: null }));
    expect(await fin(wo)).toMatchObject({ customer_subtotal: 278, margin: 12.6, customer_from_invoice: false });
  });

  it("does not count one invoice for two linked work orders twice: each keeps its own share", async () => {
    const a = await sarahsOrder({ status: "completed" });
    const b = await sarahsOrder({ status: "in_process", shop: f.shopB });
    await must(cds.client.from("work_order_links").insert({ work_order_id: b, linked_work_order_id: a }));
    const claimed = (await must(cds.client.rpc("cds_claim_qbo_invoice", { p_work_order: b, p_snapshot: "snap", p_linked: a }))) as {
      claim_id: string;
      work_order_id: string;
      linked_work_order_id: string;
    };
    const invoiceId = `CRM${runId}c`;
    await must(
      cds.client.rpc("cds_finish_qbo_invoice", {
        p_work_order: claimed.work_order_id,
        p_claim: claimed.claim_id,
        p_outcome: "created",
        p_qb_invoice_id: invoiceId,
      }),
    );
    await must(
      cds.client.rpc("cds_mark_invoiced_linked", {
        p_work_order: claimed.work_order_id,
        p_linked: claimed.linked_work_order_id,
        p_qb_invoice_id: invoiceId,
        p_qb_invoice_number: null,
        p_qb_tax_total: 39,
        p_qb_total: 595,
      }),
    );
    const finA = await fin(a);
    const finB = await fin(b);
    expect(finA).toMatchObject({ customer_subtotal: 278, customer_from_invoice: false });
    expect(finB).toMatchObject({ customer_subtotal: 278, customer_from_invoice: false });
  });

  it("is never visible to a shop", async () => {
    const wo = await sarahsOrder();
    expect(await fin(wo, shop)).toBeNull();
    const ship = await shop.client.from("work_order_customer_shipping").select("amount").eq("work_order_id", wo);
    expect(ship.data ?? []).toEqual([]);
  });
});
