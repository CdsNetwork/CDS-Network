/**
 * ShipStation: shops see the labels on their own work orders (carrier, service, tracking,
 * the PDF) but never label costs, rates, carrier setup, ship-from settings or webhook
 * events; anonymous callers see nothing; labels are written only through the cds_ functions;
 * tracking webhooks are applied only by the service role, once per delivery, and never to
 * test labels.
 *
 * The carrier rows are the ones the migration seeds (se-7157769 USPS, se-7157832 FedEx) and
 * are never changed here. Fixtures are created with the service role under a per-run id and
 * removed afterwards.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shopA: string; shopB: string; customer: string; wo: string; testShipment: string; realShipment: string };

let f: Fixture;
let cds: Login;
let shopA: Login;
let shopB: Login;

const LABEL = `SS-${runId}`;
const REAL_TRACKING = `7946${runId}`;
const CDS_ONLY = ["shipment_label_costs", "shipping_carriers", "shipping_services", "shipping_settings", "shipstation_webhook_events"] as const;
const NEW_TABLES = ["shipment_labels", ...CDS_ONLY] as const;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

function labelPayload(over: Record<string, unknown>) {
  return {
    shipstation_label_id: `se-test-${runId}-${Math.random().toString(36).slice(2, 8)}`,
    shipstation_shipment_id: `se-${runId}`,
    shipstation_carrier_id: "se-7157769",
    service_code: "usps_ground_advantage",
    service_name: "USPS Ground Advantage",
    tracking_number: "9999999999999",
    is_test: true,
    label_url: "https://api.shipstation.com/v2/downloads/test.pdf",
    ship_to_summary: "Shop A, Phoenix AZ 85034",
    rate_id: "se-rate-1",
    quoted_total: 21.5,
    label_cost: 0,
    insurance_cost: 0,
    currency: "USD",
    delivery_days: 3,
    ...over,
  };
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

beforeAll(async () => {
  const a = await insertOne("affiliates", { short_code: `SA-${runId}`, display_name: `Shop SA ${runId}` });
  const b = await insertOne("affiliates", { short_code: `SB-${runId}`, display_name: `Shop SB ${runId}` });
  const customer = await insertOne("customers", { code: `SC-${runId}`, name: `Customer SS ${runId}` });
  const wo = await insertOne("work_orders", {
    customer_id: customer.id,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: a.id,
    status: "accepted",
    unit_number: "U1",
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  const s1 = await insertOne("shipments", { work_order_id: wo.id, direction: "customer_to_affiliate" });
  const s2 = await insertOne("shipments", { work_order_id: wo.id, direction: "affiliate_to_customer" });
  await must(admin.from("shipment_internal").insert([{ shipment_id: s1.id }, { shipment_id: s2.id }]));
  f = { shopA: a.id, shopB: b.id, customer: customer.id, wo: wo.id, testShipment: s1.id, realShipment: s2.id };
  cds = await createLogin("cds", null);
  shopA = await createLogin("shop", a.id);
  shopB = await createLogin("shop", b.id);
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
  const shipmentIds = f ? [f.testShipment, f.realShipment] : [];
  const labelIds: string[] = [];
  await step("find labels", async () => {
    if (shipmentIds.length) {
      labelIds.push(...(await must(admin.from("shipment_labels").select("id").in("shipment_id", shipmentIds))).map((r: { id: string }) => r.id));
    }
  });
  await step("delete webhook events", () =>
    must(admin.from("shipstation_webhook_events").delete().or(`tracking_number.eq.${REAL_TRACKING},tracking_number.eq.9999999999999,tracking_number.like.UNKNOWN-${runId}`)),
  );
  if (shipmentIds.length) {
    await step("delete sync rows", () => must(admin.from("integration_sync").delete().in("entity_id", shipmentIds)));
  }
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  const rowIds = [...labelIds, cds?.id, shopA?.id, shopB?.id].filter((v): v is string => !!v);
  await step("find shop and customer ids", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["affiliates", "short_code"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
  });
  if (f) rowIds.push(f.shopA, f.shopB, f.customer);
  await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));

  const head = { count: "exact" as const, head: true };
  const left: string[] = [];
  for (const [label, query] of [
    ["work orders", admin.from("work_orders").select("id", head).eq("location_label", LABEL)],
    ["labels", admin.from("shipment_labels").select("id", head).in("id", labelIds.length ? labelIds : ["00000000-0000-0000-0000-000000000000"])],
    ["webhook events", admin.from("shipstation_webhook_events").select("id", head).eq("tracking_number", REAL_TRACKING)],
    ["shops", admin.from("affiliates").select("id", head).like("short_code", suffix)],
  ] as const) {
    const { count, error } = await query;
    if (error) errors.push(`check ${label}: ${error.message}`);
    else if (count) left.push(`${count} ${label}`);
  }
  if (errors.length || left.length) {
    throw new Error(
      `cleanup of run ${runId} incomplete.` +
        (errors.length ? ` Failed steps: ${errors.join("; ")}.` : "") +
        (left.length ? ` Left in the database: ${left.join(", ")}.` : ""),
    );
  }
}, 120_000);

describe("labels written by CDS", () => {
  it("a new leg waits for a label until one is made", async () => {
    const legs = await must(admin.from("shipments").select("status, label_status").in("id", [f.testShipment, f.realShipment]));
    expect(legs).toEqual([
      { status: "label_needed", label_status: "needed" },
      { status: "label_needed", label_status: "needed" },
    ]);
  });

  it("a test label is recorded without touching tracking or costs, and only one label per leg", async () => {
    const id = await must(cds.client.rpc("cds_record_shipment_label", { p_shipment: f.testShipment, p_label: labelPayload({}) }));
    expect(typeof id).toBe("string");
    const sh = await must(admin.from("shipments").select("carrier, tracking_number, label_status, status, service_level").eq("id", f.testShipment).single());
    expect(sh).toMatchObject({ carrier: "USPS", tracking_number: null, label_status: "ready", status: "label_created", service_level: "USPS Ground Advantage" });
    const internal = await must(admin.from("shipment_internal").select("quoted_cost, actual_cost").eq("shipment_id", f.testShipment).single());
    expect(internal).toEqual({ quoted_cost: null, actual_cost: null });

    const again = await cds.client.rpc("cds_record_shipment_label", { p_shipment: f.testShipment, p_label: labelPayload({}) });
    expect(again.error?.message).toMatch(/already has a label/);
  });

  it("a real label sets tracking and the CDS-only cost", async () => {
    await must(
      cds.client.rpc("cds_record_shipment_label", {
        p_shipment: f.realShipment,
        p_label: labelPayload({
          shipstation_label_id: `se-${runId}-real`,
          shipstation_carrier_id: "se-7157832",
          service_code: "fedex_ground",
          service_name: "FedEx Ground",
          tracking_number: REAL_TRACKING,
          is_test: false,
          label_cost: 20.78,
        }),
      }),
    );
    const sh = await must(admin.from("shipments").select("carrier, tracking_number").eq("id", f.realShipment).single());
    expect(sh).toEqual({ carrier: "FedEx", tracking_number: REAL_TRACKING });
    const internal = await must(admin.from("shipment_internal").select("quoted_cost, actual_cost").eq("shipment_id", f.realShipment).single());
    expect(Number(internal.actual_cost)).toBe(20.78);
    expect(Number(internal.quoted_cost)).toBe(21.5);
  });

  it("CDS cannot write label rows directly, nor apply webhooks", async () => {
    const insert = await cds.client.from("shipment_labels").insert({
      shipment_id: f.testShipment,
      work_order_id: f.wo,
      shipstation_label_id: `se-direct-${runId}`,
      shipstation_carrier_id: "se-7157769",
      carrier: "USPS",
      service_code: "x",
      is_test: true,
    });
    expect(insert.error).not.toBeNull();
    const hook = await cds.client.rpc("shipstation_record_webhook", {
      p_body_sha256: sha(`cds-${runId}`),
      p_resource_type: "API_TRACK",
      p_tracking_number: REAL_TRACKING,
      p_status_code: "DE",
      p_status: "delivered",
      p_estimated_delivery: null,
      p_events: [],
      p_payload: {},
    });
    expect(hook.error).not.toBeNull();
  });
});

describe("what a shop sees", () => {
  it("its own labels without any cost, and none of the CDS-only tables", async () => {
    const labels = await must(shopA.client.from("shipment_labels").select("*").eq("work_order_id", f.wo));
    expect(labels).toHaveLength(2);
    for (const l of labels as Record<string, unknown>[]) {
      for (const key of Object.keys(l)) expect(key).not.toMatch(/cost|rate|amount|total|price/i);
    }
    for (const table of CDS_ONLY) {
      const { data, error } = await shopA.client.from(table).select("*").limit(5);
      expect(error ? [] : data, table).toEqual([]);
    }
    const internal = await shopA.client.from("shipment_internal").select("*").eq("shipment_id", f.realShipment);
    expect(internal.error ? [] : internal.data).toEqual([]);
  });

  it("another shop sees none of them", async () => {
    const { data, error } = await shopB.client.from("shipment_labels").select("id").eq("work_order_id", f.wo);
    expect(error ? [] : data).toEqual([]);
  });

  it("a shop cannot create, void or write labels, nor apply webhooks", async () => {
    const create = await shopA.client.rpc("cds_record_shipment_label", { p_shipment: f.testShipment, p_label: labelPayload({}) });
    expect(create.error).not.toBeNull();
    const label = await must(admin.from("shipment_labels").select("id").eq("shipment_id", f.realShipment).eq("status", "active").single());
    const voided = await shopA.client.rpc("cds_void_shipment_label", { p_label: label.id, p_message: "no" });
    expect(voided.error).not.toBeNull();
    await shopA.client.from("shipment_labels").update({ status: "voided" }).eq("id", label.id);
    const still = await must(admin.from("shipment_labels").select("status").eq("id", label.id).single());
    expect(still.status).toBe("active");
    const hook = await shopA.client.rpc("shipstation_record_webhook", {
      p_body_sha256: sha(`shop-${runId}`),
      p_resource_type: "API_TRACK",
      p_tracking_number: REAL_TRACKING,
      p_status_code: "DE",
      p_status: "delivered",
      p_estimated_delivery: null,
      p_events: [],
      p_payload: {},
    });
    expect(hook.error).not.toBeNull();
  });
});

describe("anonymous callers", () => {
  it("read nothing and call nothing", async () => {
    for (const table of NEW_TABLES) {
      const { data, error } = await anon().from(table).select("*").limit(5);
      expect(error ? [] : data, table).toEqual([]);
    }
    const r = await anon().rpc("cds_record_shipment_label", { p_shipment: f.testShipment, p_label: labelPayload({}) });
    expect(r.error).not.toBeNull();
  });
});

describe("tracking webhook (service role)", () => {
  const call = (body: string, tracking: string, status: string | null, events: unknown[] = []) =>
    admin.rpc("shipstation_record_webhook", {
      p_body_sha256: sha(body),
      p_resource_type: "API_TRACK",
      p_tracking_number: tracking,
      p_status_code: status === "delivered" ? "DE" : "IT",
      p_status: status,
      p_estimated_delivery: "2026-10-22T00:00:00Z",
      p_events: events,
      p_payload: { run: runId },
    });

  it("applies an update to the real label's shipment once, with its events", async () => {
    const events = [
      { occurred_at: "2026-10-19T14:02:00Z", carrier_code: "PU", description: "Picked up", location: "Phoenix, AZ" },
      { occurred_at: "2026-10-20T03:40:00Z", carrier_code: "DP", description: "Departed", location: "Albuquerque, NM" },
    ];
    expect(await must(call(`a-${runId}`, REAL_TRACKING, "in_transit", events))).toBe("applied");
    expect(await must(call(`a-${runId}`, REAL_TRACKING, "in_transit", events))).toBe("duplicate");
    // The next delivery repeats the old events and adds one.
    expect(
      await must(
        call(`b-${runId}`, REAL_TRACKING, "delivered", [
          ...events,
          { occurred_at: "2026-10-22T18:00:00Z", carrier_code: "DL", description: "Delivered", location: "Phoenix, AZ" },
        ]),
      ),
    ).toBe("applied");
    const sh = await must(admin.from("shipments").select("status, label_status").eq("id", f.realShipment).single());
    expect(sh).toEqual({ status: "delivered", label_status: "printed" });
    const stored = await must(admin.from("shipment_tracking_events").select("carrier_code").eq("shipment_id", f.realShipment).order("occurred_at"));
    expect(stored.map((e: { carrier_code: string }) => e.carrier_code)).toEqual(["PU", "DP", "DL"]);
  });

  it("never tracks a test label and ignores unknown tracking numbers", async () => {
    expect(await must(call(`t-${runId}`, "9999999999999", "delivered"))).toBe("unknown_tracking");
    expect(await must(call(`u-${runId}`, `UNKNOWN-${runId}`, "delivered"))).toBe("unknown_tracking");
    const sh = await must(admin.from("shipments").select("status").eq("id", f.testShipment).single());
    expect(sh.status).toBe("label_created");
  });
});

describe("voiding", () => {
  it("voiding a test label puts the leg back to needing a label, for CDS and the shop", async () => {
    const label = await must(admin.from("shipment_labels").select("id").eq("shipment_id", f.testShipment).eq("status", "active").single());
    await must(cds.client.rpc("cds_void_shipment_label", { p_label: label.id, p_message: null }));
    const sh = await must(admin.from("shipments").select("status, label_status, label_file_path").eq("id", f.testShipment).single());
    expect(sh).toEqual({ status: "label_needed", label_status: "voided", label_file_path: null });
    const seen = await must(shopA.client.from("shipments").select("status").eq("id", f.testShipment).single());
    expect(seen.status).toBe("label_needed");
    const active = await must(shopA.client.from("shipment_labels").select("id").eq("shipment_id", f.testShipment).eq("status", "active"));
    expect(active).toEqual([]);
  });

  it("CDS voids a real label: tracking and the actual cost are cleared, a new label is allowed", async () => {
    const label = await must(admin.from("shipment_labels").select("id").eq("shipment_id", f.realShipment).eq("status", "active").single());
    await must(cds.client.rpc("cds_void_shipment_label", { p_label: label.id, p_message: "Wrong service" }));
    const sh = await must(admin.from("shipments").select("tracking_number, label_status, status").eq("id", f.realShipment).single());
    // The carrier already reported this leg delivered, so its tracking status is kept.
    expect(sh).toEqual({ tracking_number: null, label_status: "voided", status: "delivered" });
    const internal = await must(admin.from("shipment_internal").select("actual_cost").eq("shipment_id", f.realShipment).single());
    expect(internal.actual_cost).toBeNull();
    const twice = await cds.client.rpc("cds_void_shipment_label", { p_label: label.id, p_message: null });
    expect(twice.error?.message).toMatch(/already voided/);
  });
});
