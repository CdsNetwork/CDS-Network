/**
 * CDS-only internal status (Sarah, CDS dispatch, 2026-11-12;
 * 20261112030000_internal_status.sql).
 *
 * work_order_internal.internal_status holds one of six values CDS sets by hand, or nothing.
 * It lives on the CDS-only table, not on work_orders (which shops read through shop_read), so
 * a shop login can neither read nor change it, and it never changes the order's status.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shopId: string;
let customer: string;
let cds: Login;
let shop: Login;
let wo: string;

const LABEL = `IST-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

beforeAll(async () => {
  shopId = (await insertOne("affiliates", { short_code: `IST-${runId}`, display_name: `Shop IST ${runId}` })).id;
  customer = (await insertOne("customers", { code: `IST-${runId}`, name: `Customer IST ${runId}` })).id;
  wo = (
    await insertOne("work_orders", {
      customer_id: customer,
      location_label: LABEL,
      fulfillment: "shipping",
      affiliate_id: shopId,
      status: "in_process",
      unit_number: "U-1",
      requested_work: "Test cleaning",
    })
  ).id;
  await must(admin.from("work_order_internal").insert({ work_order_id: wo }));
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().eq("id", customer));
  await must(admin.from("affiliates").delete().eq("id", shopId));
}, 120_000);

const read = async () =>
  (await must(admin.from("work_order_internal").select("internal_status").eq("work_order_id", wo).single())).internal_status as string | null;

describe("internal status", () => {
  it("is blank by default; CDS sets and clears it, and the order status does not move", async () => {
    expect(await read()).toBeNull();
    for (const value of ["eta_sent", "condemned", "invoice_ready", "invoice_sent", "no_action_needed", "closed"]) {
      await must(cds.client.from("work_order_internal").update({ internal_status: value }).eq("work_order_id", wo));
      expect(await read()).toBe(value);
    }
    await must(cds.client.from("work_order_internal").update({ internal_status: null }).eq("work_order_id", wo));
    expect(await read()).toBeNull();
    const order = await must(admin.from("work_orders").select("status").eq("id", wo).single());
    expect(order.status).toBe("in_process");
  });

  it("refuses any other value", async () => {
    const { error } = await cds.client.from("work_order_internal").update({ internal_status: "invoiced" }).eq("work_order_id", wo);
    expect(error).not.toBeNull();
  });

  it("a shop login cannot read it", async () => {
    await must(admin.from("work_order_internal").update({ internal_status: "invoice_sent" }).eq("work_order_id", wo));
    // The shop can read its order, but internal_status is not a work_orders column.
    const order = await must(shop.client.from("work_orders").select("id").eq("id", wo));
    expect(order).toHaveLength(1);
    const onOrder = await shop.client.from("work_orders").select("internal_status").eq("id", wo);
    expect(onOrder.error).not.toBeNull();
    const internal = await shop.client.from("work_order_internal").select("internal_status").eq("work_order_id", wo);
    expect(internal.data ?? []).toEqual([]);
    const embedded = await shop.client.from("work_orders").select("id, work_order_internal(internal_status)").eq("id", wo);
    for (const row of (embedded.data ?? []) as { work_order_internal: unknown }[]) {
      expect(row.work_order_internal).toBeNull();
    }
  });

  it("a shop login cannot change it", async () => {
    await must(admin.from("work_order_internal").update({ internal_status: "eta_sent" }).eq("work_order_id", wo));
    const res = await shop.client.from("work_order_internal").update({ internal_status: "closed" }).eq("work_order_id", wo).select("work_order_id");
    expect(res.data ?? []).toEqual([]);
    const onOrder = await shop.client.from("work_orders").update({ internal_status: "closed" }).eq("id", wo);
    expect(onOrder.error).not.toBeNull();
    expect(await read()).toBe("eta_sent");
  });
});
