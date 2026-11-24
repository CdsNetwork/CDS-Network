/**
 * Fulfillment method after dispatch (Sarah, CDS, 2026-11-24),
 * 20261124000000_fulfillment_after_dispatch.sql: public.cds_set_fulfillment(order, method).
 *
 *  - CDS switches a dispatched order between shipping and pickup; the shop reads the new method
 *    on its job straight away; a CDS-only history event names the old and new method.
 *  - To pickup: refused while a purchased label is not voided, or a label is being bought;
 *    shipment legs without a label stay. An accepted job gets the window 'coordinate' (the
 *    table needs a window on an accepted pickup job); before acceptance none is set.
 *  - To shipping: pickup day and window cleared, the shop's shipping status starts.
 *  - Refused in review, cancelled, invoiced, with a QuickBooks invoice, while the invoice is
 *    being created, once the shop's bill is in QuickBooks or while it is being created. A CDS
 *    approval of the shop's bill not yet sent is cleared (the shipping deduction changes).
 *  - Only CDS; after dispatch a direct update of the column is refused (in review the Edit
 *    order box still updates it).
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `FAD-${runId}`;
let shop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;
let n = 0;

async function workOrder(over: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const wo = (await must(
    admin
      .from("work_orders")
      .insert({
        customer_id: customer,
        location_label: LABEL,
        fulfillment: "shipping",
        affiliate_id: shop,
        status: "accepted",
        request_type: "service",
        unit_number: `FAD-${n}`,
        requested_work: "Test cleaning",
        ...over,
      })
      .select("id")
      .single(),
  )) as { id: string };
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

const set = (wo: string, method: string, login: Login = cds) => login.client.rpc("cds_set_fulfillment", { p_work_order: wo, p_fulfillment: method });
const row = (wo: string) =>
  must(admin.from("work_orders").select("fulfillment, pickup_window, pickup_date, shop_ship_status").eq("id", wo).single());

const shipment = async (wo: string) =>
  ((await must(admin.from("shipments").insert({ work_order_id: wo, direction: "customer_to_affiliate", carrier: "UPS" }).select("id").single())) as { id: string }).id;

const label = async (wo: string, s: string) =>
  ((await must(
    admin
      .from("shipment_labels")
      .insert({
        shipment_id: s,
        work_order_id: wo,
        shipstation_label_id: `se-${runId}-${n}-${randomUUID().slice(0, 6)}`,
        shipstation_carrier_id: "se-7157832",
        carrier: "UPS",
        service_code: "ups_ground",
        is_test: true,
        ship_from_summary: "Test",
        ship_to_summary: "Test",
      })
      .select("id")
      .single(),
  )) as { id: string }).id;

beforeAll(async () => {
  shop = ((await must(admin.from("affiliates").insert({ short_code: LABEL, display_name: `Fulfillment Shop ${runId}` }).select().single())) as { id: string }).id;
  customer = ((await must(admin.from("customers").insert({ code: LABEL, name: `Fulfillment Customer ${runId}` }).select().single())) as { id: string }).id;
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("customer_id", customer));
  await deleteLogins();
  await must(admin.from("customers").delete().eq("code", LABEL));
  await must(admin.from("affiliates").delete().eq("short_code", LABEL));
}, 120_000);

describe("cds_set_fulfillment", () => {
  it("switches an accepted shipping job to pickup; the shop sees it; a CDS-only event names both methods", async () => {
    const wo = await workOrder({ shop_ship_status: "awaiting_delivery" });
    await must(set(wo, "pickup"));
    expect(await row(wo)).toMatchObject({ fulfillment: "pickup", pickup_window: "coordinate", pickup_date: null });
    const seen = await must(shopLogin.client.from("work_orders").select("fulfillment, pickup_window").eq("id", wo).single());
    expect(seen).toEqual({ fulfillment: "pickup", pickup_window: "coordinate" });
    const events = await must(admin.from("work_order_events").select("event_type, message, shop_visible, actor_id").eq("work_order_id", wo));
    expect(events).toContainEqual({
      event_type: "edit",
      message: "Fulfillment changed by CDS: Shipping / Carrier to Affiliate Pickup / Local Delivery",
      shop_visible: false,
      actor_id: cds.id,
    });
    // The shop can now set the day and window of its accepted pickup job.
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await must(shopLogin.client.rpc("shop_set_pickup", { p_work_order: wo, p_pickup_date: day, p_pickup_window: "08-10" }));
    expect(await row(wo)).toMatchObject({ pickup_window: "08-10", pickup_date: day });
  });

  it("before acceptance no window is set: the shop chooses it when it accepts", async () => {
    const wo = await workOrder({ status: "awaiting_acceptance" });
    await must(set(wo, "pickup"));
    expect(await row(wo)).toMatchObject({ fulfillment: "pickup", pickup_window: null });
  });

  it("switches to shipping: pickup day and window cleared, shipping status starts", async () => {
    const wo = await workOrder({ fulfillment: "pickup", pickup_window: "08-10", pickup_date: "2026-12-01" });
    await must(set(wo, "shipping"));
    expect(await row(wo)).toEqual({ fulfillment: "shipping", pickup_window: null, pickup_date: null, shop_ship_status: "awaiting_delivery" });
    const done = await workOrder({
      fulfillment: "pickup",
      pickup_window: "08-10",
      status: "completed",
      completed_at: new Date().toISOString(),
      affiliate_invoice_ref: `FAD-INV-${n}`,
    });
    await must(set(done, "shipping"));
    expect(await row(done)).toMatchObject({ fulfillment: "shipping", shop_ship_status: "ready_to_ship" });
  });

  it("to pickup is refused while a purchased label is not voided; a voided label or a leg without one does not block", async () => {
    const wo = await workOrder();
    const s = await shipment(wo);
    const l = await label(wo, s);
    const refused = await set(wo, "pickup");
    expect(refused.error?.message).toMatch(/Void the label/);
    expect((await row(wo)).fulfillment).toBe("shipping");
    await must(admin.from("shipment_labels").update({ status: "voided", voided_at: new Date().toISOString() }).eq("id", l));
    await must(set(wo, "pickup"));
    expect((await row(wo)).fulfillment).toBe("pickup");
    // The leg stays: CDS removes it in Logistics if it is not needed.
    expect(await must(admin.from("shipments").select("id").eq("id", s))).toHaveLength(1);
  });

  it("to pickup is refused while a label is being bought", async () => {
    const wo = await workOrder();
    const s = await shipment(wo);
    await must(cds.client.rpc("cds_claim_shipstation", { p_kind: "label", p_target: s }));
    expect((await set(wo, "pickup")).error?.message).toMatch(/label is being created/);
    expect((await row(wo)).fulfillment).toBe("shipping");
  });

  it("refused in review, cancelled and once the order is invoiced", async () => {
    for (const status of ["pending_review", "rejected_by_affiliate", "cancelled"]) {
      const wo = await workOrder({ status });
      expect((await set(wo, "pickup")).error?.message, status).toMatch(/Edit order box|cancelled/);
    }
    const invoiced = await workOrder();
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: invoiced, p_qb_invoice_id: `FAD${runId}`, p_qb_invoice_number: null }));
    expect((await set(invoiced, "pickup")).error?.message).toMatch(/invoiced in QuickBooks/);
    expect((await row(invoiced)).fulfillment).toBe("shipping");
  });

  it("refused while the QuickBooks invoice is being created", async () => {
    const wo = await workOrder();
    await must(admin.from("qbo_invoice_claims").insert({ work_order_id: wo, state: "sending", claim_id: randomUUID(), claimed_at: new Date().toISOString() }));
    expect((await set(wo, "pickup")).error?.message).toMatch(/being created in QuickBooks/);
    expect((await row(wo)).fulfillment).toBe("shipping");
  });

  it("refused once the shop's bill is in QuickBooks or while it is being created", async () => {
    const billed = await workOrder();
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: billed, status: "created", qb_bill_id: `FADB${runId}` }));
    expect((await set(billed, "pickup")).error?.message).toMatch(/shop's bill is in QuickBooks/);
    const creating = await workOrder();
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: creating, status: "creating", claim_id: randomUUID(), claimed_at: new Date().toISOString() }));
    expect((await set(creating, "pickup")).error?.message).toMatch(/shop's bill is being created/);
    expect((await row(billed)).fulfillment).toBe("shipping");
    expect((await row(creating)).fulfillment).toBe("shipping");
  });

  it("clears a CDS approval of the shop's bill not yet sent", async () => {
    const wo = await workOrder({ status: "completed", completed_at: new Date().toISOString(), affiliate_invoice_ref: `FAD-INV-A${n}` });
    await must(admin.from("work_order_internal").update({ shop_bill_approved_at: new Date().toISOString() }).eq("work_order_id", wo));
    await must(set(wo, "pickup"));
    const internal = await must(admin.from("work_order_internal").select("shop_bill_approved_at").eq("work_order_id", wo).single());
    expect(internal.shop_bill_approved_at).toBeNull();
  });

  it("only shipping or pickup; the same method again changes nothing and logs nothing", async () => {
    const wo = await workOrder();
    expect((await set(wo, "supplier_direct")).error?.message).toMatch(/Choose shipping or shop pickup/);
    await must(set(wo, "shipping"));
    expect(await must(admin.from("work_order_events").select("id").eq("work_order_id", wo))).toHaveLength(0);
  });

  it("only CDS: the shop cannot call it nor change the column", async () => {
    const wo = await workOrder();
    expect((await set(wo, "pickup", shopLogin)).error?.message).toMatch(/Only CDS staff/);
    await shopLogin.client.from("work_orders").update({ fulfillment: "pickup", pickup_window: "08-10" }).eq("id", wo);
    expect((await row(wo)).fulfillment).toBe("shipping");
  });

  it("after dispatch CDS cannot update the column directly; in review it can (Edit order box)", async () => {
    const wo = await workOrder();
    const direct = await cds.client.from("work_orders").update({ fulfillment: "pickup", pickup_window: "08-10" }).eq("id", wo).select("id");
    expect(direct.error?.message).toMatch(/Edit fulfillment/);
    expect((await row(wo)).fulfillment).toBe("shipping");
    const review = await workOrder({ status: "pending_review", affiliate_id: null });
    await must(cds.client.from("work_orders").update({ fulfillment: "pickup" }).eq("id", review).select("id").single());
    expect((await row(review)).fulfillment).toBe("pickup");
  });
});
