/**
 * Carrier pickups: CDS only. CDS reads pickups and books or cancels them only through the
 * cds_ functions (after ShipStation answered); only for a real label in use, one scheduled
 * pickup per label, and a label with a scheduled pickup cannot be voided. A shop, even the
 * one on the work order, sees no pickup and cannot call the functions; anonymous callers
 * see nothing.
 *
 * Labels are inserted with the service role (the carrier rows are the ones the shipstation
 * migration seeds and are never changed here). Fixtures are created under a per-run id and
 * removed afterwards. Nothing here calls ShipStation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shop: string; customer: string; wo: string; realShipment: string; testShipment: string; realLabel: string; testLabel: string };

let f: Fixture;
let cds: Login;
let shop: Login;

const LABEL = `PICKUP-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const pickupPayload = (over: Record<string, unknown> = {}) => ({
  shipstation_pickup_id: `pik_${runId}_${Math.random().toString(36).slice(2, 8)}`,
  confirmation_number: "292513CL4A3",
  window_start: "2026-11-11T16:00:00.000Z",
  window_end: "2026-11-12T00:00:00.000Z",
  time_zone: "America/Phoenix",
  notes: "Dock 4",
  ...over,
});

beforeAll(async () => {
  const s = await insertOne("affiliates", { short_code: `PA-${runId}`, display_name: `Shop Pickup ${runId}` });
  const customer = await insertOne("customers", { code: `PC-${runId}`, name: `Customer Pickup ${runId}` });
  const wo = await insertOne("work_orders", {
    customer_id: customer.id,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: s.id,
    status: "accepted",
    unit_number: "P1",
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  const real = await insertOne("shipments", { work_order_id: wo.id, direction: "customer_to_affiliate" });
  const test = await insertOne("shipments", { work_order_id: wo.id, direction: "affiliate_to_customer" });
  const label = (shipment: string, isTest: boolean) =>
    insertOne("shipment_labels", {
      shipment_id: shipment,
      work_order_id: wo.id,
      shipstation_label_id: `se-${isTest ? "test-" : ""}${runId}-pickup`,
      shipstation_carrier_id: isTest ? "se-7157769" : "se-7157832",
      carrier: isTest ? "USPS" : "FedEx",
      service_code: isTest ? "usps_ground_advantage" : "fedex_ground",
      is_test: isTest,
      ship_from_summary: "Ryder 0412, 4500 W Buckeye Rd, Phoenix AZ 85043",
    });
  const realLabel = await label(real.id, false);
  const testLabel = await label(test.id, true);
  f = { shop: s.id, customer: customer.id, wo: wo.id, realShipment: real.id, testShipment: test.id, realLabel: realLabel.id, testLabel: testLabel.id };
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", s.id);
}, 120_000);

afterAll(async () => {
  const errors: string[] = [];
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const suffix = `%-${runId}`;
  const rowIds: string[] = [cds?.id, shop?.id].filter((v): v is string => !!v);
  if (f) {
    rowIds.push(f.shop, f.customer, f.realLabel, f.testLabel);
    await step("find pickups", async () => {
      rowIds.push(...(await must(admin.from("shipment_pickups").select("id").eq("label_id", f.realLabel))).map((r: { id: string }) => r.id));
    });
    await step("delete sync rows", () => must(admin.from("integration_sync").delete().in("entity_id", [f.realShipment, f.testShipment])));
  }
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (f) {
    const { count, error } = await admin.from("shipment_pickups").select("id", { count: "exact", head: true }).eq("label_id", f.realLabel);
    if (error) errors.push(`check pickups: ${error.message}`);
    else if (count) errors.push(`${count} pickups left in the database`);
  }
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("pickups booked by CDS", () => {
  it("CDS records a pickup for a real label and reads it back", async () => {
    const id = await must(cds.client.rpc("cds_record_shipment_pickup", { p_label: f.realLabel, p_pickup: pickupPayload() }));
    expect(typeof id).toBe("string");
    const row = await must(cds.client.from("shipment_pickups").select("*").eq("id", id).single());
    expect(row).toMatchObject({
      shipment_id: f.realShipment,
      label_id: f.realLabel,
      confirmation_number: "292513CL4A3",
      carrier: "FedEx",
      shipstation_carrier_id: "se-7157832",
      time_zone: "America/Phoenix",
      notes: "Dock 4",
      status: "scheduled",
      created_by: cds.id,
    });
    expect(new Date(row.window_start).toISOString()).toBe("2026-11-11T16:00:00.000Z");
  });

  it("only one scheduled pickup per label", async () => {
    const again = await cds.client.rpc("cds_record_shipment_pickup", { p_label: f.realLabel, p_pickup: pickupPayload() });
    expect(again.error?.message).toMatch(/already has a pickup/);
  });

  it("never for a test label", async () => {
    const r = await cds.client.rpc("cds_record_shipment_pickup", { p_label: f.testLabel, p_pickup: pickupPayload() });
    expect(r.error?.message).toMatch(/real labels/);
  });

  it("a window that ends before it starts is refused", async () => {
    const other = await insertOne("shipments", { work_order_id: f.wo, direction: "cds_to_customer" });
    const l = await insertOne("shipment_labels", {
      shipment_id: other.id,
      work_order_id: f.wo,
      shipstation_label_id: `se-${runId}-pickup-2`,
      shipstation_carrier_id: "se-7157832",
      carrier: "FedEx",
      service_code: "fedex_ground",
      is_test: false,
    });
    const r = await cds.client.rpc("cds_record_shipment_pickup", {
      p_label: l.id,
      p_pickup: pickupPayload({ window_end: "2026-11-11T15:00:00.000Z" }),
    });
    expect(r.error).not.toBeNull();
    await must(admin.from("integration_sync").delete().eq("entity_id", other.id));
    await must(admin.from("audit_log").delete().eq("row_id", l.id));
  });

  it("CDS cannot write pickup rows directly", async () => {
    const insert = await cds.client.from("shipment_pickups").insert({
      shipment_id: f.realShipment,
      label_id: f.realLabel,
      shipstation_pickup_id: `pik_direct_${runId}`,
      shipstation_carrier_id: "se-7157832",
      carrier: "FedEx",
      window_start: "2026-11-11T16:00:00Z",
      window_end: "2026-11-12T00:00:00Z",
      time_zone: "America/Phoenix",
    });
    expect(insert.error).not.toBeNull();
    const pickup = await must(admin.from("shipment_pickups").select("id").eq("label_id", f.realLabel).eq("status", "scheduled").single());
    await cds.client.from("shipment_pickups").update({ status: "cancelled" }).eq("id", pickup.id);
    const still = await must(admin.from("shipment_pickups").select("status").eq("id", pickup.id).single());
    expect(still.status).toBe("scheduled");
  });

  it("a label with a scheduled pickup cannot be voided", async () => {
    const r = await cds.client.rpc("cds_void_shipment_label", { p_label: f.realLabel, p_message: "test" });
    expect(r.error?.message).toMatch(/Cancel the pickup before voiding/);
    const l = await must(admin.from("shipment_labels").select("status").eq("id", f.realLabel).single());
    expect(l.status).toBe("active");
  });
});

describe("what a shop sees", () => {
  it("no pickup, even on its own work order, and no functions", async () => {
    const { data, error } = await shop.client.from("shipment_pickups").select("*").eq("shipment_id", f.realShipment);
    expect(error ? [] : data).toEqual([]);
    const pickup = await must(admin.from("shipment_pickups").select("id").eq("label_id", f.realLabel).eq("status", "scheduled").single());
    const cancel = await shop.client.rpc("cds_cancel_shipment_pickup", { p_pickup: pickup.id });
    expect(cancel.error).not.toBeNull();
    const book = await shop.client.rpc("cds_record_shipment_pickup", { p_label: f.realLabel, p_pickup: pickupPayload() });
    expect(book.error).not.toBeNull();
    const still = await must(admin.from("shipment_pickups").select("status").eq("id", pickup.id).single());
    expect(still.status).toBe("scheduled");
  });

  it("the pickup events on the work order are CDS only", async () => {
    const events = await must(shop.client.from("work_order_events").select("message").eq("work_order_id", f.wo));
    for (const e of events as { message: string | null }[]) expect(e.message ?? "").not.toMatch(/pickup/i);
  });
});

describe("anonymous callers", () => {
  it("read nothing and call nothing", async () => {
    const { data, error } = await anon().from("shipment_pickups").select("*").limit(5);
    expect(error ? [] : data).toEqual([]);
    const r = await anon().rpc("cds_record_shipment_pickup", { p_label: f.realLabel, p_pickup: pickupPayload() });
    expect(r.error).not.toBeNull();
  });
});

describe("cancelling", () => {
  it("CDS cancels a pickup once, and can then book a new one", async () => {
    const pickup = await must(admin.from("shipment_pickups").select("id").eq("label_id", f.realLabel).eq("status", "scheduled").single());
    await must(cds.client.rpc("cds_cancel_shipment_pickup", { p_pickup: pickup.id }));
    const row = await must(admin.from("shipment_pickups").select("status, cancelled_at, cancelled_by").eq("id", pickup.id).single());
    expect(row).toMatchObject({ status: "cancelled", cancelled_by: cds.id });
    expect(row.cancelled_at).not.toBeNull();
    const twice = await cds.client.rpc("cds_cancel_shipment_pickup", { p_pickup: pickup.id });
    expect(twice.error?.message).toMatch(/already cancelled/);
    await must(cds.client.rpc("cds_record_shipment_pickup", { p_label: f.realLabel, p_pickup: pickupPayload() }));
  });
});
