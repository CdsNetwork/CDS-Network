/**
 * Shops see and print only the label of the leg back to the customer (Sarah, CDS,
 * 2026-11-17; 20261119020000_shop_labels_outbound_only.sql). The shipment_labels shop_read
 * policy now also needs the label's shipment to be affiliate_to_customer. The shipments rows
 * stay readable, so the shop still sees the inbound tracking number. CDS sees every label.
 * The label PDF route reads the label with the caller's client, so it follows the same rule.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shop: string;
let customer: string;
let wo: string;
let inbound: string;
let outbound: string;
let cds: Login;
let shopLogin: Login;
const labels: Record<string, string> = {};

const LABEL = `LSO-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const payload = (key: string) => ({
  shipstation_label_id: `se-lso-${runId}-${key}`,
  shipstation_shipment_id: `se-${runId}-${key}`,
  shipstation_carrier_id: "se-7157769",
  service_code: "ups_ground",
  service_name: "UPS Ground",
  tracking_number: `1Z${runId}${key}`,
  is_test: true,
  ship_to_summary: "Somewhere",
  label_cost: 0,
  insurance_cost: 0,
  currency: "USD",
});

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `LO-${runId}`, display_name: `Outbound Shop ${runId}` })).id;
  customer = (await insertOne("customers", { code: `LOC-${runId}`, name: `Outbound Customer ${runId}` })).id;
  wo = (
    await insertOne("work_orders", {
      customer_id: customer,
      location_label: LABEL,
      fulfillment: "shipping",
      affiliate_id: shop,
      status: "accepted",
      unit_number: "U1",
      requested_work: "Test cleaning",
    })
  ).id;
  await must(admin.from("work_order_internal").insert({ work_order_id: wo }));
  inbound = (await insertOne("shipments", { work_order_id: wo, direction: "customer_to_affiliate", carrier: "UPS", tracking_number: `1ZIN${runId}` })).id;
  outbound = (await insertOne("shipments", { work_order_id: wo, direction: "affiliate_to_customer" })).id;
  await must(admin.from("shipment_internal").insert([{ shipment_id: inbound }, { shipment_id: outbound }]));
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
  labels.in = (await must(cds.client.rpc("cds_record_shipment_label", { p_shipment: inbound, p_label: payload("in") }))) as string;
  labels.out = (await must(cds.client.rpc("cds_record_shipment_label", { p_shipment: outbound, p_label: payload("out") }))) as string;
}, 120_000);

afterAll(async () => {
  const ids = [inbound, outbound].filter(Boolean);
  if (ids.length) await must(admin.from("integration_sync").delete().in("entity_id", ids));
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", `%-${runId}`));
  await must(admin.from("affiliates").delete().like("short_code", `%-${runId}`));
}, 120_000);

describe("labels a shop sees", () => {
  it("only the label of the leg back to the customer", async () => {
    const rows = (await must(shopLogin.client.from("shipment_labels").select("id, shipment_id").eq("work_order_id", wo))) as { id: string; shipment_id: string }[];
    expect(rows).toEqual([{ id: labels.out, shipment_id: outbound }]);
    const direct = await shopLogin.client.from("shipment_labels").select("id").eq("id", labels.in);
    expect(direct.error ? [] : direct.data).toEqual([]);
  });

  it("still both shipment legs, with the inbound tracking number", async () => {
    const ships = (await must(shopLogin.client.from("shipments").select("id, tracking_number").eq("work_order_id", wo))) as { id: string; tracking_number: string | null }[];
    expect(ships.map((s) => s.id).sort()).toEqual([inbound, outbound].sort());
    expect(ships.find((s) => s.id === inbound)?.tracking_number).toBe(`1ZIN${runId}`);
  });

  it("CDS still sees both labels", async () => {
    const rows = (await must(cds.client.from("shipment_labels").select("id").eq("work_order_id", wo))) as { id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual([labels.in, labels.out].sort());
  });
});
