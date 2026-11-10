/**
 * CDS deletes a work order (public.cds_delete_work_order). The order and everything on it
 * goes in one transaction; another order is untouched; a shop cannot delete; an order with
 * a real label in use is refused; the email that created the order stays, marked not a
 * request; the QuickBooks invoice reference is returned and kept in the change log.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `DELWO-${runId}`;

let shop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(unit: string): Promise<{ id: string; wo_number: number }> {
  const wo = await insertOne<{ id: string; wo_number: number }>("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shop,
    status: "accepted",
    unit_number: unit,
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo;
}

async function shipment(wo: string): Promise<string> {
  return (await insertOne("shipments", { work_order_id: wo, direction: "customer_to_affiliate", carrier: "UPS" })).id;
}

const count = async (table: string, column: string, value: string) => {
  const { count: n, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(column, value);
  if (error) throw new Error(error.message);
  return n ?? 0;
};

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `DWS-${runId}`, display_name: `Delete WO Shop ${runId}` })).id;
  customer = (await insertOne("customers", { code: `DWC-${runId}`, name: `Delete WO Customer ${runId}` })).id;
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
}, 120_000);

afterAll(async () => {
  await admin.from("integration_sync").delete().eq("external_id", `DELWO-${runId}`);
  await admin.from("inbound_emails").delete().like("provider_message_id", `%${runId}%`);
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().eq("id", shop);
}, 120_000);

describe("cds_delete_work_order", () => {
  it("deletes the order and its rows, keeps other orders, and keeps the email as not a request", async () => {
    const wo = await workOrder("DW-1");
    const other = await workOrder("DW-2");
    const ship = await shipment(wo.id);
    const otherShip = await shipment(other.id);
    await must(admin.from("work_order_notes").insert({ work_order_id: wo.id, author_name: "CDS", body: "note" }));
    await must(admin.from("work_order_events").insert({ work_order_id: wo.id, event_type: "note", message: "x" }));
    await must(
      admin.from("integration_sync").insert([
        { system: "quickbooks", entity: "invoice", entity_id: wo.id, external_id: `DELWO-${runId}`, status: "ok", error: "QuickBooks invoice number 1034" },
        { system: "shipstation", entity: "label", entity_id: ship, external_id: `DELWO-${runId}`, status: "error" },
        { system: "shipstation", entity: "label", entity_id: otherShip, external_id: `DELWO-${runId}`, status: "error" },
      ]),
    );
    const email = await insertOne("inbound_emails", {
      mailbox: "intake",
      provider_message_id: `delwo-${runId}@test.invalid`,
      received_at: new Date().toISOString(),
      status: "converted",
      work_order_id: wo.id,
      parsed: { is_work_request: true },
    });

    const { data, error } = await cds.client.rpc("cds_delete_work_order", { p_work_order: wo.id });
    expect(error).toBeNull();
    expect(data).toMatchObject({ wo_number: wo.wo_number, qb_invoice_id: `DELWO-${runId}`, qb_invoice_number: "1034" });

    expect(await count("work_orders", "id", wo.id)).toBe(0);
    expect(await count("work_order_internal", "work_order_id", wo.id)).toBe(0);
    expect(await count("shipments", "work_order_id", wo.id)).toBe(0);
    expect(await count("work_order_notes", "work_order_id", wo.id)).toBe(0);
    expect(await count("work_order_events", "work_order_id", wo.id)).toBe(0);
    expect(await count("integration_sync", "entity_id", wo.id)).toBe(0);
    expect(await count("integration_sync", "entity_id", ship)).toBe(0);

    expect(await count("work_orders", "id", other.id)).toBe(1);
    expect(await count("shipments", "id", otherShip)).toBe(1);
    expect(await count("integration_sync", "entity_id", otherShip)).toBe(1);

    const kept = await must(admin.from("inbound_emails").select("status, work_order_id, parsed").eq("id", email.id).single());
    expect(kept).toMatchObject({ status: "ignored", work_order_id: null });
    expect((kept as { parsed: { ignore_reason: string } }).parsed.ignore_reason).toBe(`Its work order WO-${wo.wo_number} was deleted.`);

    const audit = await must(admin.from("audit_log").select("action, old_data").eq("table_name", "work_orders").eq("row_id", wo.id));
    expect(audit).toHaveLength(1);
    expect((audit as { old_data: { qb_invoice_number: string } }[])[0].old_data.qb_invoice_number).toBe("1034");
  });

  it("refuses an order with a real label in use, and allows a test label", async () => {
    const wo = await workOrder("DW-3");
    const ship = await shipment(wo.id);
    const label = {
      shipment_id: ship,
      work_order_id: wo.id,
      shipstation_label_id: `se-del-${runId}`,
      shipstation_carrier_id: "se-1",
      carrier: "UPS",
      service_code: "ups_ground",
      is_test: false,
    };
    const real = await insertOne("shipment_labels", label);
    const refused = await cds.client.rpc("cds_delete_work_order", { p_work_order: wo.id });
    expect(refused.error?.message).toMatch(/label in use/);
    expect(await count("work_orders", "id", wo.id)).toBe(1);

    await must(admin.from("shipment_labels").update({ is_test: true }).eq("id", real.id));
    const ok = await cds.client.rpc("cds_delete_work_order", { p_work_order: wo.id });
    expect(ok.error).toBeNull();
    expect(await count("shipment_labels", "id", real.id)).toBe(0);
  });

  it("is refused for a shop", async () => {
    const wo = await workOrder("DW-4");
    const res = await shopLogin.client.rpc("cds_delete_work_order", { p_work_order: wo.id });
    expect(res.error).not.toBeNull();
    expect(await count("work_orders", "id", wo.id)).toBe(1);
  });
});
