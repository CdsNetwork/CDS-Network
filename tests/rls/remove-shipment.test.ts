/**
 * A shipment is removed only through public.cds_remove_shipment
 * (20261118040000_remove_shipment_rpc.sql).
 *
 * Review 2026-11-16: public.shipments could be deleted with a plain DELETE through the Data API
 * by any CDS login, skipping the checks of the Remove button (order not invoiced, no label in
 * use, no tracking number, label status needed or voided). The checks now run in the database.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `RMS-${runId}`;
let shopId: string;
let customer: string;
let cds: Login;
let shop: Login;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function order(status = "accepted"): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shopId,
    status,
    unit_number: "R1",
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

const shipment = async (wo: string, over: Record<string, unknown> = {}) =>
  (await insertOne("shipments", { work_order_id: wo, direction: "customer_to_affiliate", carrier: "UPS", ...over })).id;
const exists = async (id: string) => (await must(admin.from("shipments").select("id").eq("id", id))).length === 1;
const remove = (login: Login, wo: string, id: string) => login.client.rpc("cds_remove_shipment", { p_work_order: wo, p_shipment: id });

beforeAll(async () => {
  shopId = (await insertOne("affiliates", { short_code: `RMS-${runId}`, display_name: `Shop RMS ${runId}` })).id;
  customer = (await insertOne("customers", { code: `RMS-${runId}`, name: `Customer RMS ${runId}` })).id;
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().eq("id", shopId);
}, 120_000);

describe("deleting a shipment through the Data API", () => {
  it("is not possible for a CDS login, also for a shipment with a tracking number", async () => {
    const wo = await order();
    const s = await shipment(wo, { tracking_number: `1Z${runId}` });
    const { error } = await cds.client.from("shipments").delete().eq("id", s);
    expect(error?.message).toMatch(/permission denied/);
    expect(await exists(s)).toBe(true);
  });
});

describe("cds_remove_shipment", () => {
  it("removes a leg with no label and no tracking number and logs it", async () => {
    const wo = await order();
    const s = await shipment(wo);
    const { error } = await remove(cds, wo, s);
    expect(error).toBeNull();
    expect(await exists(s)).toBe(false);
    const events = await must(admin.from("work_order_events").select("event_type, message, shop_visible").eq("work_order_id", wo));
    expect(events).toEqual([{ event_type: "shipment", message: "Shipment removed: UPS", shop_visible: false }]);
  });

  it("removes a leg whose label was voided", async () => {
    const wo = await order();
    const s = await shipment(wo, { label_status: "voided" });
    expect((await remove(cds, wo, s)).error).toBeNull();
    expect(await exists(s)).toBe(false);
  });

  it("refuses a tracking number, a label in use or being made, an invoiced order, and another order's leg", async () => {
    const wo = await order();
    const tracked = await shipment(wo, { tracking_number: `1Z${runId}b` });
    expect((await remove(cds, wo, tracked)).error?.message).toBe("This shipment has a tracking number, so it cannot be removed.");

    const labelled = await shipment(wo);
    await must(
      admin.from("shipment_labels").insert({
        shipment_id: labelled,
        work_order_id: wo,
        shipstation_label_id: `se-${runId}-rm`,
        shipstation_carrier_id: "se-7157832",
        carrier: "FedEx",
        service_code: "fedex_ground",
        is_test: false,
        ship_from_summary: "Test",
      }),
    );
    expect((await remove(cds, wo, labelled)).error?.message).toBe("This shipment has a label. Void the label first, then remove the shipment.");

    const ready = await shipment(wo, { label_status: "ready" });
    expect((await remove(cds, wo, ready)).error?.message).toBe(
      "This shipment has a label or one is being made. Void the label first, then remove the shipment.",
    );

    const other = await order();
    expect((await remove(cds, other, ready)).error?.message).toBe("Shipment not found.");

    // Invoiced in QuickBooks while the shop is still working on it.
    const invoiced = await order("in_process");
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: invoiced, p_qb_invoice_id: `RMS${runId}`, p_qb_invoice_number: null }));
    const late = await shipment(invoiced);
    expect((await remove(cds, invoiced, late)).error?.message).toBe("Shipments cannot be removed after the order is invoiced.");

    for (const id of [tracked, labelled, ready, late]) expect(await exists(id)).toBe(true);
  });

  it("is refused for shops", async () => {
    const wo = await order();
    const s = await shipment(wo);
    expect((await remove(shop, wo, s)).error).not.toBeNull();
    expect(await exists(s)).toBe(true);
  });
});
