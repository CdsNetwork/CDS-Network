/**
 * Pickup day (Clyde, CDS, 2026-11-18; 20261119130000_shop_pickup_date.sql): a shop accepting a
 * pickup job chooses the day (not in the past, Pacific) and the window; both are required. The
 * shop may change them with public.shop_set_pickup until the part is picked up; that change
 * marks the order "New from shop" ('eta') like a window change. A declined job loses its day
 * with its window. Shops read the day and the step dates of their own jobs only.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pacificToday } from "@/lib/dates";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shop: string;
let otherShop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;
let otherLogin: Login;

const LABEL = `PDATE-${runId}`;
const day = (offset: number) => pacificToday(new Date(Date.now() + offset * 86_400_000));

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
    dispatched_at: new Date().toISOString(),
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

const row = async (wo: string) =>
  (await must(admin.from("work_orders").select("status, pickup_date, pickup_window").eq("id", wo).single())) as {
    status: string;
    pickup_date: string | null;
    pickup_window: string | null;
  };

const activity = async (wo: string) =>
  (await must(admin.from("work_order_shop_activity").select("shop_activity").eq("work_order_id", wo).maybeSingle())) as {
    shop_activity: string | null;
  } | null;

const accept = (wo: string, window: string | null, date: string | null, login = shopLogin) =>
  login.client.rpc("shop_accept_work_order", { p_work_order: wo, p_pickup_window: window, p_pickup_date: date });

const setPickup = (wo: string, date: string | null, window: string | null, login = shopLogin) =>
  login.client.rpc("shop_set_pickup", { p_work_order: wo, p_pickup_date: date, p_pickup_window: window });

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `PA-${runId}`, display_name: `Pickup Shop ${runId}` })).id;
  otherShop = (await insertOne("affiliates", { short_code: `PB-${runId}`, display_name: `Other Shop ${runId}` })).id;
  customer = (await insertOne("customers", { code: `PC-${runId}`, name: `Pickup Customer ${runId}` })).id;
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
  otherLogin = await createLogin("shop", otherShop);
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
}, 120_000);

describe("Accepting a pickup job with a day", () => {
  it("stores the day and the window", async () => {
    const wo = await workOrder("D-1", "pickup");
    await must(accept(wo, "10-12", day(0)));
    expect(await row(wo)).toEqual({ status: "accepted", pickup_date: day(0), pickup_window: "10-12" });
  });

  it("needs both the day and the window", async () => {
    const wo = await workOrder("D-2", "pickup");
    expect((await accept(wo, "10-12", null)).error?.message).toMatch(/pickup day/);
    expect((await accept(wo, null, day(1))).error?.message).toMatch(/pickup window/);
    expect((await row(wo)).status).toBe("awaiting_acceptance");
  });

  it("refuses a day in the past, more than a year out, or the old Tomorrow window", async () => {
    const wo = await workOrder("D-3", "pickup");
    expect((await accept(wo, "08-10", day(-1))).error?.message).toMatch(/past/);
    expect((await accept(wo, "08-10", day(400))).error?.message).toMatch(/year/);
    expect((await accept(wo, "tomorrow", day(1))).error?.message).toMatch(/window/);
    expect((await row(wo)).status).toBe("awaiting_acceptance");
  });

  it("keeps Need to coordinate", async () => {
    const wo = await workOrder("D-4", "pickup");
    await must(accept(wo, "coordinate", day(2)));
    expect(await row(wo)).toMatchObject({ pickup_date: day(2), pickup_window: "coordinate" });
  });

  it("a shipped job is accepted without a day", async () => {
    const wo = await workOrder("D-5", "shipping");
    await must(accept(wo, null, null));
    expect(await row(wo)).toEqual({ status: "accepted", pickup_date: null, pickup_window: null });
  });
});

describe("Changing the pickup day later", () => {
  it("the shop changes day and window while the job is accepted; it marks the order New from shop", async () => {
    const wo = await workOrder("D-6", "pickup");
    await must(accept(wo, "08-10", day(1)));
    expect(await activity(wo)).toBeNull();
    await must(setPickup(wo, day(3), "08-10")); // day only
    expect(await row(wo)).toMatchObject({ pickup_date: day(3), pickup_window: "08-10" });
    expect(await activity(wo)).toEqual({ shop_activity: "eta" });
    await must(setPickup(wo, day(3), "14-16"));
    expect(await row(wo)).toMatchObject({ pickup_date: day(3), pickup_window: "14-16" });
    const events = await must(admin.from("work_order_events").select("event_type, shop_visible").eq("work_order_id", wo).eq("event_type", "pickup_eta"));
    expect(events).toHaveLength(2);
  });

  it("gives an order accepted before the day existed a day", async () => {
    const wo = await workOrder("D-7", "pickup");
    await must(admin.from("work_orders").update({ status: "accepted", pickup_window: "tomorrow" }).eq("id", wo));
    await must(setPickup(wo, day(1), "10-12"));
    expect(await row(wo)).toMatchObject({ pickup_date: day(1), pickup_window: "10-12" });
  });

  it("is refused once the part is picked up, on a shipped job, with a past day, or without both", async () => {
    const wo = await workOrder("D-8", "pickup");
    await must(accept(wo, "08-10", day(1)));
    expect((await setPickup(wo, day(-1), "08-10")).error?.message).toMatch(/past/);
    expect((await setPickup(wo, null, "08-10")).error?.message).toMatch(/pickup day/);
    expect((await setPickup(wo, day(1), "tomorrow")).error?.message).toMatch(/window/);
    await must(shopLogin.client.rpc("shop_set_progress", { p_work_order: wo, p_status: "picked_up" }));
    expect((await setPickup(wo, day(2), "08-10")).error?.message).toMatch(/picked up/);
    expect(await row(wo)).toMatchObject({ pickup_date: day(1), pickup_window: "08-10" });

    const ship = await workOrder("D-9", "shipping");
    await must(accept(ship, null, null));
    expect((await setPickup(ship, day(1), "08-10")).error?.message).toMatch(/pickup job/);
  });

  it("another shop cannot change it, nor read it", async () => {
    const wo = await workOrder("D-10", "pickup");
    await must(accept(wo, "08-10", day(1)));
    const res = await setPickup(wo, day(2), "10-12", otherLogin);
    expect(res.error?.code).toBe("P0002");
    const seen = await must(otherLogin.client.from("work_orders").select("id").eq("id", wo));
    expect(seen).toEqual([]);
    expect(await row(wo)).toMatchObject({ pickup_date: day(1), pickup_window: "08-10" });
  });

  it("anonymous callers cannot run it", async () => {
    const { anon } = await import("./helpers");
    const res = await anon().rpc("shop_set_pickup", { p_work_order: "00000000-0000-4000-8000-000000000000", p_pickup_date: day(1), p_pickup_window: "08-10" });
    expect(res.error).not.toBeNull();
  });
});

describe("Day and step dates", () => {
  it("a declined job loses its day with its window", async () => {
    const wo = await workOrder("D-11", "pickup");
    await must(accept(wo, "08-10", day(1)));
    await must(shopLogin.client.rpc("shop_decline_work_order", { p_work_order: wo, p_reason: "No driver" }));
    expect(await row(wo)).toMatchObject({ status: "rejected_by_affiliate", pickup_date: null, pickup_window: null });
  });

  it("CDS clearing the window clears the day", async () => {
    const wo = await workOrder("D-12", "pickup");
    await must(accept(wo, "08-10", day(1)));
    await must(cds.client.from("work_orders").update({ status: "awaiting_acceptance", pickup_window: null }).eq("id", wo));
    expect(await row(wo)).toMatchObject({ pickup_date: null, pickup_window: null });
  });

  it("the shop reads the day and the step dates of its own job", async () => {
    const wo = await workOrder("D-13", "pickup");
    await must(accept(wo, "12-14", day(1)));
    const own = (await must(
      shopLogin.client
        .from("work_orders")
        .select("pickup_date, pickup_window, dispatched_at, accepted_at, picked_up_at, completed_at, delivered_at")
        .eq("id", wo)
        .single(),
    )) as Record<string, string | null>;
    expect(own.pickup_date).toBe(day(1));
    expect(own.dispatched_at).not.toBeNull();
    expect(own.accepted_at).not.toBeNull();
    const fromCds = await must(cds.client.from("work_orders").select("pickup_date").eq("id", wo).single());
    expect(fromCds).toEqual({ pickup_date: day(1) });
  });
});
