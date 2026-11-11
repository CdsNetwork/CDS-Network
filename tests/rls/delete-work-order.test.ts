/**
 * CDS deletes a work order (public.cds_delete_work_order). The order and everything on it
 * goes in one transaction; another order is untouched; a shop cannot delete; an order with
 * a real label in use is refused; the email that created the order stays, marked not a
 * request; the QuickBooks invoice reference is returned and kept in the change log.
 *
 * Only a profile with can_delete_work_orders (Sarah, 20261111060000) may delete: another CDS
 * login is refused, and no API login can give itself or anyone else the permission.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `DELWO-${runId}`;

let shop: string;
let customer: string;
let cds: Login;
let otherCds: Login;
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
  // The permission Sarah has; set with the service role, as only a migration or the service role can.
  await must(admin.from("profiles").update({ can_delete_work_orders: true }).eq("id", cds.id));
  otherCds = await createLogin("cds", null);
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

  it("is refused for CDS staff without the permission", async () => {
    const wo = await workOrder("DW-5");
    const res = await otherCds.client.rpc("cds_delete_work_order", { p_work_order: wo.id });
    expect(res.error?.code).toBe("42501");
    expect(res.error?.message).toBe("Only Sarah can delete work orders. Ask her to delete this one.");
    expect(await count("work_orders", "id", wo.id)).toBe(1);
  });

  it("is refused for a shop", async () => {
    const wo = await workOrder("DW-4");
    const res = await shopLogin.client.rpc("cds_delete_work_order", { p_work_order: wo.id });
    expect(res.error).not.toBeNull();
    expect(await count("work_orders", "id", wo.id)).toBe(1);
  });
});

describe("can_delete_work_orders", () => {
  const flag = async (id: string) =>
    ((await must(admin.from("profiles").select("can_delete_work_orders").eq("id", id).single())) as { can_delete_work_orders: boolean })
      .can_delete_work_orders;

  it("is on for sarah@cds.direct only, besides this run's test logins", async () => {
    const rows = (await must(admin.from("profiles").select("email, kind").eq("can_delete_work_orders", true))) as { email: string; kind: string }[];
    for (const r of rows) {
      expect(r.kind).toBe("cds");
      expect(r.email === "sarah@cds.direct" || /^rls-cds-[a-z0-9]+-\d+@test\.invalid$/.test(r.email), r.email).toBe(true);
    }
  });

  it("cannot be switched on by CDS staff, for themselves or for another login", async () => {
    for (const target of [otherCds.id, shopLogin.id]) {
      const res = await otherCds.client.from("profiles").update({ can_delete_work_orders: true }).eq("id", target).select("id");
      expect(res.error?.code).toBe("42501");
    }
    expect(await flag(otherCds.id)).toBe(false);
    expect(await flag(shopLogin.id)).toBe(false);
  });

  it("cannot be switched off by the CDS login that has it, nor changed with other fields", async () => {
    const res = await cds.client.from("profiles").update({ can_delete_work_orders: false, full_name: "Renamed" }).eq("id", cds.id).select("id");
    expect(res.error).not.toBeNull();
    expect(await flag(cds.id)).toBe(true);
  });

  it("does not stop CDS from changing other profile fields", async () => {
    const res = await cds.client.from("profiles").update({ full_name: `RLS cds ${runId} renamed` }).eq("id", otherCds.id).select("id");
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
  });

  it("cannot be set by a shop on its own profile", async () => {
    const res = await shopLogin.client.from("profiles").update({ can_delete_work_orders: true }).eq("id", shopLogin.id).select("id");
    // No shop update policy: nothing is updated (or the trigger refuses).
    expect(res.data ?? []).toHaveLength(0);
    expect(await flag(shopLogin.id)).toBe(false);
  });

  it("cannot be given to a new profile through the API", async () => {
    const res = await otherCds.client
      .from("profiles")
      .insert({ id: randomUUID(), full_name: "x", email: `rls-new-${runId.toLowerCase()}@test.invalid`, kind: "cds", can_delete_work_orders: true });
    // Refused by the trigger, before any other check.
    expect(res.error?.code).toBe("42501");
  });

  it("is only possible on a CDS profile", async () => {
    const res = await admin.from("profiles").update({ can_delete_work_orders: true }).eq("id", shopLogin.id);
    expect(res.error?.message).toMatch(/profiles_delete_permission_cds_only/);
  });
});
