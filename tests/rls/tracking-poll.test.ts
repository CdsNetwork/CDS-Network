/**
 * Tracking by polling (ShipStation GET /v2/labels/{label_id}/track, every 2 hours) and the
 * automatic Delivered step:
 *   * only the service role lists the labels to poll and records results;
 *   * results go through the same status mapping and event code as the webhook;
 *   * a delivered return leg (to the customer) moves a completed work order to Delivered as
 *     the system, with the carrier's delivery time; an inbound leg never moves the order;
 *     a cancelled, invoiced or not yet completed order is not moved (a not yet completed one
 *     is moved by the sweep once the shop completes it).
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `TP-${runId}`;
const suffix = `%-${runId}`;
let cds: Login;
let shop: string;
let customer: string;
const wo: Record<"done" | "working" | "invoiced", string> = { done: "", working: "", invoiced: "" };
const leg: Record<"inbound" | "outbound" | "working" | "invoiced" | "test", string> = {
  inbound: "",
  outbound: "",
  working: "",
  invoiced: "",
  test: "",
};
const label: Record<keyof typeof leg, string> = { inbound: "", outbound: "", working: "", invoiced: "", test: "" };

async function insertOne(table: string, row: Record<string, unknown>): Promise<{ id: string }> {
  return must(admin.from(table).insert(row).select("id").single()) as Promise<{ id: string }>;
}

async function workOrder(status: string, ref: string | null): Promise<string> {
  const w = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shop,
    status,
    affiliate_invoice_ref: ref,
    unit_number: "U1",
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: w.id }));
  return w.id;
}

async function legWithLabel(workOrderId: string, direction: string, key: keyof typeof leg, isTest = false) {
  const s = await insertOne("shipments", { work_order_id: workOrderId, direction, status: "label_created", label_status: "ready" });
  const l = await insertOne("shipment_labels", {
    shipment_id: s.id,
    work_order_id: workOrderId,
    shipstation_label_id: `se-tp-${runId}-${key}`,
    shipstation_carrier_id: "se-7157832",
    carrier: "FedEx",
    service_code: "fedex_ground",
    tracking_number: `TP${runId}${key}`,
    is_test: isTest,
  });
  leg[key] = s.id;
  label[key] = l.id;
}

const record = (key: keyof typeof leg, over: Record<string, unknown> = {}) =>
  admin.rpc("shipstation_record_tracking", {
    p_label: label[key],
    p_status_code: "DE",
    p_status: "delivered",
    p_estimated_delivery: null,
    p_actual_delivery: "2026-10-22T17:15:00Z",
    p_events: [{ occurred_at: "2026-10-22T17:15:00Z", carrier_code: "DL", description: "Delivered", location: "Reno, NV" }],
    p_error: null,
    ...over,
  });

const tracked = async () =>
  ((await must(admin.rpc("shipstation_labels_to_track", { p_limit: 1000 }))) as { label_id: string }[]).map((r) => r.label_id);

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `TA-${runId}`, display_name: `Shop TP ${runId}` })).id;
  customer = (await insertOne("customers", { code: `TC-${runId}`, name: `Customer TP ${runId}` })).id;
  wo.done = await workOrder("completed", "SHOP-INV-1");
  wo.working = await workOrder("in_process", null);
  wo.invoiced = await workOrder("invoiced", "SHOP-INV-2");
  await legWithLabel(wo.done, "customer_to_affiliate", "inbound");
  await legWithLabel(wo.done, "affiliate_to_customer", "outbound");
  await legWithLabel(wo.working, "affiliate_to_customer", "working");
  await legWithLabel(wo.invoiced, "affiliate_to_customer", "invoiced");
  await legWithLabel(wo.invoiced, "customer_to_affiliate", "test", true);
  cds = await createLogin("cds", null);
}, 120_000);

afterAll(async () => {
  const ids = Object.values(leg).filter(Boolean);
  const labelIds = Object.values(label).filter(Boolean);
  if (ids.length) await must(admin.from("integration_sync").delete().in("entity_id", ids));
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
  await must(admin.from("audit_log").delete().in("row_id", [...labelIds, shop, customer, cds?.id].filter(Boolean)));
  const { count } = await admin.from("work_orders").select("id", { count: "exact", head: true }).eq("location_label", LABEL);
  expect(count).toBe(0);
}, 120_000);

describe("labels to poll", () => {
  it("lists active real labels whose leg is not delivered, never test labels", async () => {
    const ids = await tracked();
    expect(ids).toEqual(expect.arrayContaining([label.inbound, label.outbound, label.working, label.invoiced]));
    expect(ids).not.toContain(label.test);
  });

  it("is for the service role only", async () => {
    const list = await cds.client.rpc("shipstation_labels_to_track", { p_limit: 10 });
    expect(list.error).not.toBeNull();
    const rec = await cds.client.rpc("shipstation_record_tracking", {
      p_label: label.outbound,
      p_status_code: "DE",
      p_status: "delivered",
      p_estimated_delivery: null,
      p_actual_delivery: null,
      p_events: [],
      p_error: null,
    });
    expect(rec.error).not.toBeNull();
    const sweep = await cds.client.rpc("shipstation_auto_deliver_sweep");
    expect(sweep.error).not.toBeNull();
  });
});

describe("recording a poll result", () => {
  it("records an error without touching the leg", async () => {
    expect(await must(record("outbound", { p_error: "ShipStation could not be reached" }))).toBe("error");
    const sh = await must(admin.from("shipments").select("status").eq("id", leg.outbound).single());
    expect(sh.status).toBe("label_created");
  });

  it("an inbound leg delivered never moves the work order", async () => {
    expect(await must(record("inbound"))).toBe("applied");
    const sh = await must(admin.from("shipments").select("status, delivered_at").eq("id", leg.inbound).single());
    expect(sh.status).toBe("delivered");
    expect(new Date(sh.delivered_at).toISOString()).toBe("2026-10-22T17:15:00.000Z");
    const w = await must(admin.from("work_orders").select("status, delivered_at").eq("id", wo.done).single());
    expect(w).toEqual({ status: "completed", delivered_at: null });
  });

  it("the return leg delivered moves the completed order to Delivered as the system", async () => {
    // In transit first: same mapping as the webhook, no move.
    expect(
      await must(
        record("outbound", {
          p_status_code: "IT",
          p_status: "in_transit",
          p_actual_delivery: null,
          p_events: [{ occurred_at: "2026-10-21T08:00:00Z", carrier_code: "IT", description: "In transit", location: "Sparks, NV" }],
        }),
      ),
    ).toBe("applied");
    expect((await must(admin.from("work_orders").select("status").eq("id", wo.done).single())).status).toBe("completed");

    expect(await must(record("outbound"))).toBe("applied");
    const w = await must(admin.from("work_orders").select("status, delivered_at").eq("id", wo.done).single());
    expect(w.status).toBe("delivered");
    expect(new Date(w.delivered_at).toISOString()).toBe("2026-10-22T17:15:00.000Z");
    const events = await must(
      admin.from("work_order_events").select("actor_id, from_status, to_status, message, shop_visible").eq("work_order_id", wo.done).eq("to_status", "delivered"),
    );
    expect(events).toEqual([
      { actor_id: null, from_status: "completed", to_status: "delivered", message: "Delivered per carrier tracking 2026-10-22 10:15 PT", shop_visible: true },
    ]);
    const stored = await must(admin.from("shipment_tracking_events").select("carrier_code").eq("shipment_id", leg.outbound).order("occurred_at"));
    expect(stored.map((e: { carrier_code: string }) => e.carrier_code)).toEqual(["IT", "DL"]);
  });

  it("the same result again changes nothing and the delivered leg is no longer polled", async () => {
    expect(await must(record("outbound"))).toBe("unchanged");
    const stored = await must(admin.from("shipment_tracking_events").select("id").eq("shipment_id", leg.outbound));
    expect(stored).toHaveLength(2);
    const moves = await must(admin.from("work_order_events").select("id").eq("work_order_id", wo.done).eq("to_status", "delivered"));
    expect(moves).toHaveLength(1);
    const ids = await tracked();
    expect(ids).not.toContain(label.outbound);
    expect(ids).not.toContain(label.inbound);
  });

  it("an invoiced order is never moved back to Delivered", async () => {
    expect(await must(record("invoiced"))).toBe("applied");
    const w = await must(admin.from("work_orders").select("status, delivered_at").eq("id", wo.invoiced).single());
    expect(w).toEqual({ status: "invoiced", delivered_at: null });
  });

  it("an order the shop has not completed waits, and the sweep moves it once completed", async () => {
    expect(await must(record("working"))).toBe("applied");
    expect((await must(admin.from("work_orders").select("status").eq("id", wo.working).single())).status).toBe("in_process");
    await must(admin.rpc("shipstation_auto_deliver_sweep"));
    expect((await must(admin.from("work_orders").select("status").eq("id", wo.working).single())).status).toBe("in_process");

    await must(admin.from("work_orders").update({ status: "completed", affiliate_invoice_ref: "SHOP-INV-3" }).eq("id", wo.working));
    expect(await must(admin.rpc("shipstation_auto_deliver_sweep"))).toBeGreaterThanOrEqual(1);
    const w = await must(admin.from("work_orders").select("status, delivered_at").eq("id", wo.working).single());
    expect(w.status).toBe("delivered");
    expect(new Date(w.delivered_at).toISOString()).toBe("2026-10-22T17:15:00.000Z");
    await must(admin.rpc("shipstation_auto_deliver_sweep"));
    const moves = await must(admin.from("work_order_events").select("id").eq("work_order_id", wo.working).eq("to_status", "delivered"));
    expect(moves).toHaveLength(1);
  });

  it("a test label is never recorded", async () => {
    expect(await must(record("test"))).toBe("skipped");
    const sh = await must(admin.from("shipments").select("status").eq("id", leg.test).single());
    expect(sh.status).toBe("label_created");
  });
});
