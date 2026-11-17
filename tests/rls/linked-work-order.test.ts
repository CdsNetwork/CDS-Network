/**
 * Linked work orders, light version (Sarah, CDS, 2026-11-17;
 * 20261119010000_linked_work_order.sql). public.work_order_links points a work order to
 * another one. It has only the CDS policy, so a shop sees nothing about the link: not on its
 * own order and not the other order (which may be another shop's). An order cannot be linked
 * to itself; deleting the other order removes the link.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shopA: string;
let shopB: string;
let customer: string;
let woA: string;
let woB: string;
let cds: Login;
let loginA: Login;

const LABEL = `LINK-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function order(affiliate: string, unit: string): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: affiliate,
    status: "accepted",
    unit_number: unit,
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

beforeAll(async () => {
  shopA = (await insertOne("affiliates", { short_code: `KA-${runId}`, display_name: `Link Shop A ${runId}` })).id;
  shopB = (await insertOne("affiliates", { short_code: `KB-${runId}`, display_name: `Link Shop B ${runId}` })).id;
  customer = (await insertOne("customers", { code: `KC-${runId}`, name: `Link Customer ${runId}` })).id;
  woA = await order(shopA, "A1");
  woB = await order(shopB, "B1");
  cds = await createLogin("cds", null);
  loginA = await createLogin("shop", shopA);
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", `%-${runId}`));
  await must(admin.from("affiliates").delete().like("short_code", `%-${runId}`));
}, 120_000);

describe("linking two work orders", () => {
  it("CDS links an order to another shop's order and reads the link from both sides", async () => {
    await must(cds.client.from("work_order_links").upsert({ work_order_id: woA, linked_work_order_id: woB }));
    const incoming = (await must(cds.client.from("work_order_links").select("work_order_id").eq("linked_work_order_id", woB))) as { work_order_id: string }[];
    expect(incoming.map((r) => r.work_order_id)).toEqual([woA]);
  });

  it("the shop sees nothing of the link and nothing of the other order", async () => {
    const links = await loginA.client.from("work_order_links").select("*");
    expect(links.error ? [] : links.data).toEqual([]);
    const own = (await must(loginA.client.from("work_orders").select("*").eq("id", woA).single())) as Record<string, unknown>;
    expect(Object.keys(own).some((k) => k.includes("link"))).toBe(false);
    const other = await loginA.client.from("work_orders").select("id").eq("id", woB);
    expect(other.error ? [] : other.data).toEqual([]);
  });

  it("the shop cannot add, change or remove a link", async () => {
    const add = await loginA.client.from("work_order_links").insert({ work_order_id: woB, linked_work_order_id: woA });
    expect(add.error).not.toBeNull();
    const del = await loginA.client.from("work_order_links").delete().eq("work_order_id", woA).select("work_order_id");
    expect(del.data ?? []).toEqual([]);
    const row = await must(admin.from("work_order_links").select("linked_work_order_id").eq("work_order_id", woA).single());
    expect(row.linked_work_order_id).toBe(woB);
  });

  it("an order cannot be linked to itself", async () => {
    const { error } = await cds.client.from("work_order_links").upsert({ work_order_id: woA, linked_work_order_id: woA });
    expect(error).not.toBeNull();
  });

  it("deleting the other order removes the link", async () => {
    const extra = await order(shopB, "B2");
    await must(admin.from("work_order_links").insert({ work_order_id: woB, linked_work_order_id: extra }));
    await must(admin.from("work_orders").delete().eq("id", extra));
    const rows = await must(admin.from("work_order_links").select("work_order_id").eq("work_order_id", woB));
    expect(rows).toEqual([]);
  });
});
