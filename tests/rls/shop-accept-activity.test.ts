/**
 * Shop accepts a job. 20261111080000_shop_accept_activity.sql marked the order "New from shop"
 * on accept; since 20261112020000_no_new_label_on_accept.sql (CDS, 2026-11-12) it does not,
 * because the acceptance email with the ETA already reaches dispatch@. Accepting sets the
 * pickup window in the same update, so that is no 'eta' either. Shop notes, files and failures
 * after the accept still flag the order; CDS's own changes of the status or the pickup window
 * never do.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;

const LABEL = `ACCEPT-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(unit: string, fulfillment: "pickup" | "shipping"): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment,
    affiliate_id: shop,
    status: "awaiting_acceptance",
    unit_number: unit,
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

const activity = async (wo: string) =>
  (await must(admin.from("work_order_shop_activity").select("is_new, shop_activity").eq("work_order_id", wo).maybeSingle())) as {
    is_new: boolean;
    shop_activity: string | null;
  } | null;

const accept = (wo: string, window: string | null) =>
  shopLogin.client.rpc("shop_accept_work_order", { p_work_order: wo, p_pickup_window: window });

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `AA-${runId}`, display_name: `Accept Shop ${runId}` })).id;
  customer = (await insertOne("customers", { code: `AC-${runId}`, name: `Accept Customer ${runId}` })).id;
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
}, 120_000);

describe("Shop accepts a job", () => {
  it("a pickup job accepted with a pickup window is not New from shop", async () => {
    const wo = await workOrder("A-1", "pickup");
    expect(await activity(wo)).toBeNull();
    await must(accept(wo, "10-12"));
    expect(await must(admin.from("work_orders").select("status, pickup_window").eq("id", wo).single())).toEqual({
      status: "accepted",
      pickup_window: "10-12",
    });
    expect(await activity(wo)).toBeNull();
  });

  it("a shipping job accepted without a window is not New from shop either", async () => {
    const wo = await workOrder("A-2", "shipping");
    await must(accept(wo, null));
    expect(await activity(wo)).toBeNull();
  });

  it("a shop note after the accept still makes it New from shop until CDS opens it", async () => {
    const wo = await workOrder("A-6", "pickup");
    await must(accept(wo, "12-14"));
    await must(shopLogin.client.from("work_order_notes").insert({ work_order_id: wo, body: "Picked up tomorrow" }));
    expect(await activity(wo)).toEqual({ is_new: true, shop_activity: "note" });
    await must(cds.client.rpc("cds_mark_work_order_seen", { p_work_order: wo }));
    expect(await activity(wo)).toEqual({ is_new: false, shop_activity: "note" });
  });

  it("the accept is logged as the 'accept' event the dispatch@ email is keyed on", async () => {
    const wo = await workOrder("A-3", "pickup");
    await must(accept(wo, "coordinate"));
    const events = await must(admin.from("work_order_events").select("event_type").eq("work_order_id", wo).eq("event_type", "accept"));
    expect(events).toHaveLength(1);
  });

  it("CDS's own status or pickup window changes never flag the order", async () => {
    const wo = await workOrder("A-4", "pickup");
    await must(cds.client.from("work_orders").update({ status: "accepted", pickup_window: "08-10" }).eq("id", wo));
    await must(cds.client.from("work_orders").update({ pickup_window: "14-16" }).eq("id", wo));
    expect(await activity(wo)).toBeNull();
  });

  it("a refused accept flags nothing", async () => {
    const wo = await workOrder("A-5", "pickup");
    const res = await accept(wo, null);
    expect(res.error?.message).toMatch(/pickup window/);
    expect(await activity(wo)).toBeNull();
  });
});
