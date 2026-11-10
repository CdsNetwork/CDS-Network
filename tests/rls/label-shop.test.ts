/**
 * Labels made before dispatch (20261110060000_label_shop.sql): CDS records the shop a label
 * was made for (shipment_labels.shop_affiliate_id) through cds_record_shipment_label. The
 * planned shop sees nothing before dispatch; dispatching to another shop is not blocked, the
 * label keeps the shop it was made for (the app compares it with the order's shop), and only
 * the shop the order went to sees the label. Nobody writes the column directly.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shopA: string; shopB: string; customer: string; location: string; service: string; wo: string; toShop: string; toCds: string };

let f: Fixture;
let cds: Login;
let shopA: Login;
let shopB: Login;

const LABEL = `LS-${runId}`;

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
    ship_to_summary: "Shop A, Phoenix AZ 85034",
    label_cost: 0,
    insurance_cost: 0,
    currency: "USD",
    ...over,
  };
}

beforeAll(async () => {
  const a = await insertOne("affiliates", { short_code: `LA-${runId}`, display_name: `Shop LA ${runId}` });
  const b = await insertOne("affiliates", { short_code: `LB-${runId}`, display_name: `Shop LB ${runId}` });
  const customer = await insertOne("customers", { code: `LC-${runId}`, name: `Customer LS ${runId}` });
  const location = await insertOne("customer_locations", {
    customer_id: customer.id,
    code: `LL-${runId}`,
    name: "Label yard",
    address_raw: "1 Test St Testville CA 90000",
    default_affiliate_id: a.id,
    fulfillment: "shipping",
  });
  const service = await insertOne("catalog_items", { sku: `LSV-${runId}`, category: "service", name: "Test cleaning", tax_class: "labor" });
  const wo = await insertOne("work_orders", {
    customer_id: customer.id,
    location_id: location.id,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: null,
    status: "pending_review",
    unit_number: "U1",
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  await must(admin.from("sell_prices").insert({ catalog_item_id: service.id, amount: 300, effective_from: "2026-01-01" }));
  await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: service.id, qty: 1 }));
  const s1 = await insertOne("shipments", { work_order_id: wo.id, direction: "customer_to_affiliate" });
  const s2 = await insertOne("shipments", { work_order_id: wo.id, direction: "cds_to_customer" });
  await must(admin.from("shipment_internal").insert([{ shipment_id: s1.id }, { shipment_id: s2.id }]));
  f = { shopA: a.id, shopB: b.id, customer: customer.id, location: location.id, service: service.id, wo: wo.id, toShop: s1.id, toCds: s2.id };
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
  const shipmentIds = f ? [f.toShop, f.toCds] : [];
  const rowIds: string[] = [];
  await step("find labels and lines", async () => {
    if (!f) return;
    rowIds.push(...(await must(admin.from("shipment_labels").select("id").in("shipment_id", shipmentIds))).map((r: { id: string }) => r.id));
    rowIds.push(...(await must(admin.from("work_order_lines").select("id").eq("work_order_id", f.wo))).map((r: { id: string }) => r.id));
    rowIds.push(f.wo, ...shipmentIds, f.location, f.service);
  });
  if (shipmentIds.length) await step("delete sync rows", () => must(admin.from("integration_sync").delete().in("entity_id", shipmentIds)));
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete locations", () => must(admin.from("customer_locations").delete().eq("code", `LL-${runId}`)));
  await step("delete catalog items", () => must(admin.from("catalog_items").delete().like("sku", suffix)));
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (f) rowIds.push(f.shopA, f.shopB, f.customer);
  for (const l of [cds, shopA, shopB]) if (l) rowIds.push(l.id);
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));

  const head = { count: "exact" as const, head: true };
  const left: string[] = [];
  for (const [label, query] of [
    ["work orders", admin.from("work_orders").select("id", head).eq("location_label", LABEL)],
    ["shops", admin.from("affiliates").select("id", head).like("short_code", suffix)],
    ["customers", admin.from("customers").select("id", head).like("code", suffix)],
    ["locations", admin.from("customer_locations").select("id", head).eq("code", `LL-${runId}`)],
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

describe("the shop a label was made for", () => {
  let labelId: string;

  it("CDS records a label for the planned shop while the order is in review", async () => {
    labelId = (await must(
      cds.client.rpc("cds_record_shipment_label", { p_shipment: f.toShop, p_label: labelPayload({ shop_affiliate_id: f.shopA }) }),
    )) as string;
    const row = await must(cds.client.from("shipment_labels").select("shop_affiliate_id, status").eq("id", labelId).single());
    expect(row).toEqual({ shop_affiliate_id: f.shopA, status: "active" });
  });

  it("a leg without a shop end records no shop, and an unknown shop is refused", async () => {
    const id = await must(cds.client.rpc("cds_record_shipment_label", { p_shipment: f.toCds, p_label: labelPayload({}) }));
    const row = await must(cds.client.from("shipment_labels").select("shop_affiliate_id").eq("id", id as string).single());
    expect(row.shop_affiliate_id).toBeNull();
    await must(cds.client.rpc("cds_void_shipment_label", { p_label: id, p_message: null }));

    const bad = await cds.client.rpc("cds_record_shipment_label", {
      p_shipment: f.toCds,
      p_label: labelPayload({ shop_affiliate_id: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(bad.error?.message).toMatch(/Unknown shop/);
  });

  it("the planned shop sees nothing before dispatch", async () => {
    for (const shop of [shopA, shopB]) {
      const { data, error } = await shop.client.from("shipment_labels").select("id").eq("work_order_id", f.wo);
      expect(error ? [] : data).toEqual([]);
      const ships = await shop.client.from("shipments").select("id").eq("work_order_id", f.wo);
      expect(ships.error ? [] : ships.data).toEqual([]);
    }
  });

  it("dispatching to another shop is not blocked; the label keeps the shop it was made for", async () => {
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: f.wo, p_affiliate: f.shopB }));
    const wo = await must(admin.from("work_orders").select("affiliate_id, status").eq("id", f.wo).single());
    expect(wo).toEqual({ affiliate_id: f.shopB, status: "awaiting_acceptance" });
    const row = await must(cds.client.from("shipment_labels").select("shop_affiliate_id, status").eq("id", labelId).single());
    expect(row).toEqual({ shop_affiliate_id: f.shopA, status: "active" });
  });

  it("only the shop the order went to sees the label; the planned shop still sees nothing", async () => {
    const seenByB = await must(shopB.client.from("shipment_labels").select("id").eq("work_order_id", f.wo).eq("status", "active"));
    expect(seenByB.map((r: { id: string }) => r.id)).toContain(labelId);
    const seenByA = await shopA.client.from("shipment_labels").select("id").eq("work_order_id", f.wo);
    expect(seenByA.error ? [] : seenByA.data).toEqual([]);
  });

  it("nobody writes the column directly", async () => {
    for (const client of [cds.client, shopB.client, anon()]) {
      const { data } = await client.from("shipment_labels").update({ shop_affiliate_id: f.shopB }).eq("id", labelId).select("id");
      expect(data ?? []).toEqual([]);
    }
    const row = await must(admin.from("shipment_labels").select("shop_affiliate_id").eq("id", labelId).single());
    expect(row.shop_affiliate_id).toBe(f.shopA);
  });
});
