/**
 * QuickBooks sites become portal locations (20261119220000_qbo_location_sync.sql). The run
 * record is CDS only; only the server (service role) links and creates locations through the
 * sync functions, never twice for one QuickBooks customer, also when runs overlap. A shop
 * reads no location row (so not the new columns either). Dispatching the first order of a
 * location that needs setup saves that order's shop and fulfillment as its defaults, once;
 * a default shop saved by CDS clears needs_setup too.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 * Nothing here calls QuickBooks. Company and site names are made up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const SUFFIX = `-${runId}`;
const LABEL = `QLS-${runId}`;
let shopA: string;
let shopB: string;
let customer: string;
let service: string;
let cds: Login;
let shop: Login;
const qboId = (n: number) => `8${runId.replace(/\D/g, "").slice(0, 5) || "1"}${n}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const site = (n: number, over: Record<string, unknown> = {}) => ({
  customer_id: customer,
  code: `${n}-PINE RIDGE${SUFFIX}`,
  location_number: String(n),
  name: `ACME - ${n}-PINE RIDGE CO`,
  address_raw: "15 Mill Rd, Pine Ridge, CO 80901",
  address_line1: "15 Mill Rd",
  city: "Pine Ridge",
  region: "co",
  postal_code: "80901",
  country: "US",
  market: "US",
  qbo_customer_id: qboId(n),
  qbo_customer_name: `Acme Fleet:ACME - ${n}-PINE RIDGE CO`,
  ...over,
});

beforeAll(async () => {
  shopA = (await insertOne("affiliates", { short_code: `QA${SUFFIX}`, display_name: `Shop QA ${runId}` })).id;
  shopB = (await insertOne("affiliates", { short_code: `QB${SUFFIX}`, display_name: `Shop QB ${runId}` })).id;
  customer = (await insertOne("customers", { code: `QC${SUFFIX}`, name: `Acme Fleet ${runId}` })).id;
  service = (await insertOne("catalog_items", { sku: `QSV${SUFFIX}`, category: "service", name: "Test cleaning", tax_class: "labor" })).id;
  await must(admin.from("sell_prices").insert({ catalog_item_id: service, amount: 300, effective_from: "2026-01-01" }));
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopA);
}, 120_000);

afterAll(async () => {
  const locs = customer ? ((await must(admin.from("customer_locations").select("id").eq("customer_id", customer))) as { id: string }[]).map((l) => l.id) : [];
  await admin.from("work_orders").delete().like("location_label", `${LABEL}%`);
  if (locs.length) {
    await admin.from("customer_locations").delete().in("id", locs);
    await admin.from("audit_log").delete().in("row_id", locs);
  }
  await admin.from("qbo_location_sync_runs").delete().eq("error", `test ${runId}`);
  await deleteLogins();
  await admin.from("catalog_items").delete().eq("id", service);
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().in("id", [shopA, shopB]);
  await admin.from("audit_log").delete().in("row_id", [shopA, shopB, customer, service]);
}, 120_000);

describe("qbo_location_sync_runs", () => {
  it("CDS reads the run record; a shop and anon read nothing; nobody signed in writes it", async () => {
    const row = await must(
      admin.from("qbo_location_sync_runs").insert({ trigger: "cron", status: "failed", started_at: new Date().toISOString(), error: `test ${runId}` }).select("id").single(),
    );
    expect(await must(cds.client.from("qbo_location_sync_runs").select("id, status").eq("id", row.id))).toEqual([{ id: row.id, status: "failed" }]);
    for (const client of [shop.client, anon()]) {
      const { data, error } = await client.from("qbo_location_sync_runs").select("id").limit(5);
      expect(error ? [] : data).toEqual([]);
    }
    for (const client of [cds.client, shop.client]) {
      expect((await client.from("qbo_location_sync_runs").insert({ trigger: "manual", status: "ok", started_at: new Date().toISOString() })).error).not.toBeNull();
      await client.from("qbo_location_sync_runs").update({ status: "ok" }).eq("id", row.id);
      await client.from("qbo_location_sync_runs").delete().eq("id", row.id);
    }
    expect((await must(admin.from("qbo_location_sync_runs").select("status").eq("id", row.id).single())).status).toBe("failed");
  });
});

describe("the on/off setting", () => {
  it("exists (the migration adds it off) and only CDS reads it", async () => {
    const row = await must(admin.from("app_settings").select("value").eq("key", "qbo_location_sync").single());
    expect(typeof (row.value as { enabled?: unknown }).enabled).toBe("boolean");
    expect((await must(cds.client.from("app_settings").select("key").eq("key", "qbo_location_sync"))).length).toBe(1);
    const { data, error } = await shop.client.from("app_settings").select("key").eq("key", "qbo_location_sync");
    expect(error ? [] : data).toEqual([]);
  });
});

describe("sync functions", () => {
  it("only the server can create or link", async () => {
    const loc = await insertOne("customer_locations", { customer_id: customer, code: `P1${SUFFIX}`, name: "Plain", address_raw: "x" });
    for (const client of [cds.client, shop.client, anon()]) {
      expect((await client.rpc("qbo_location_sync_create", { p_location: site(1) })).error).not.toBeNull();
      expect((await client.rpc("qbo_location_sync_link", { p_location: loc.id, p_qbo_customer_id: qboId(9), p_qbo_customer_name: "X" })).error).not.toBeNull();
    }
    const after = await must(admin.from("customer_locations").select("qbo_customer_id").eq("customer_id", customer));
    expect(after).toEqual([{ qbo_customer_id: null }]);
  });

  it("creates a pickup location without a default shop that needs setup; a second create returns it", async () => {
    const first = await must(admin.rpc("qbo_location_sync_create", { p_location: site(297) }));
    expect(first).toMatchObject({ created: true, code: `297-PINE RIDGE${SUFFIX}` });
    const row = await must(admin.from("customer_locations").select("*").eq("id", first.id).single());
    expect(row).toMatchObject({
      customer_id: customer,
      code: `297-PINE RIDGE${SUFFIX}`,
      location_number: "297",
      name: "ACME - 297-PINE RIDGE CO",
      address_raw: "15 Mill Rd, Pine Ridge, CO 80901",
      region: "CO",
      fulfillment: "pickup",
      default_affiliate_id: null,
      active: true,
      needs_setup: true,
      qbo_customer_id: qboId(297),
      qbo_customer_name: "Acme Fleet:ACME - 297-PINE RIDGE CO",
    });
    const again = await must(admin.rpc("qbo_location_sync_create", { p_location: site(297, { code: "OTHER" }) }));
    expect(again).toEqual({ id: first.id, created: false });
    // Another site whose code is taken gets a suffix.
    const other = await must(admin.rpc("qbo_location_sync_create", { p_location: site(298, { code: `297-PINE RIDGE${SUFFIX}` }) }));
    expect(other).toMatchObject({ created: true, code: `297-PINE RIDGE${SUFFIX}-2` });
  });

  it("overlapping runs create one location per QuickBooks customer", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => must(admin.rpc("qbo_location_sync_create", { p_location: site(400) }))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await must(admin.from("customer_locations").select("id").eq("customer_id", customer).eq("qbo_customer_id", qboId(400)));
    expect(rows).toHaveLength(1);
  });

  it("the database refuses a second location with the same QuickBooks customer for one customer", async () => {
    const { error } = await admin
      .from("customer_locations")
      .insert({ customer_id: customer, code: `DUP${SUFFIX}`, name: "Dup", address_raw: "x", qbo_customer_id: qboId(297), qbo_customer_name: "Dup" });
    expect(error?.code).toBe("23505");
  });

  it("links an unlinked location and changes nothing else; never relinks or links a QuickBooks customer twice", async () => {
    const loc = await insertOne("customer_locations", {
      customer_id: customer,
      code: `412-OAK${SUFFIX}`,
      location_number: "412",
      name: "Oak Falls",
      address_raw: "2 Oak St",
      default_affiliate_id: shopA,
      fulfillment: "shipping",
      active: false,
    });
    const link = (location: string, n: number) =>
      must(admin.rpc("qbo_location_sync_link", { p_location: location, p_qbo_customer_id: qboId(n), p_qbo_customer_name: `Acme Fleet:ACME - ${n}` }));
    expect(await link(loc.id, 412)).toBe(true);
    const row = await must(admin.from("customer_locations").select("*").eq("id", loc.id).single());
    expect(row).toMatchObject({
      code: `412-OAK${SUFFIX}`,
      name: "Oak Falls",
      default_affiliate_id: shopA,
      fulfillment: "shipping",
      active: false,
      needs_setup: false,
      qbo_customer_id: qboId(412),
      qbo_customer_name: `Acme Fleet:ACME - 412`,
    });
    expect(await link(loc.id, 413)).toBe(false);
    const plain = await insertOne("customer_locations", { customer_id: customer, code: `P2${SUFFIX}`, name: "Plain 2", address_raw: "x" });
    expect(await link(plain.id, 412)).toBe(false);
    expect((await must(admin.from("customer_locations").select("qbo_customer_id").eq("id", loc.id).single())).qbo_customer_id).toBe(qboId(412));
  });
});

describe("locations stay CDS only", () => {
  it("a shop reads no location, so not its QuickBooks customer either", async () => {
    const { data, error } = await shop.client.from("customer_locations").select("id, qbo_customer_id, needs_setup").eq("customer_id", customer);
    expect(error ? [] : data).toEqual([]);
    expect((await cds.client.from("customer_locations").select("id").eq("customer_id", customer)).data?.length).toBeGreaterThan(0);
  });
});

describe("save the first selection", () => {
  async function order(location: string, fulfillment: string) {
    const wo = await insertOne("work_orders", {
      customer_id: customer,
      location_id: location,
      location_label: `${LABEL}-${Math.random().toString(36).slice(2, 7)}`,
      fulfillment,
      status: "pending_review",
      unit_number: "U1",
      requested_work: "Test cleaning",
    });
    await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
    await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: service, qty: 1 }));
    return wo.id;
  }

  it("the first dispatched order sets the location's default shop and fulfillment; later orders do not", async () => {
    const created = await must(admin.rpc("qbo_location_sync_create", { p_location: site(530) }));
    const first = await order(created.id, "shipping");
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: first, p_affiliate: shopA }));
    const after = await must(admin.from("customer_locations").select("default_affiliate_id, fulfillment, needs_setup").eq("id", created.id).single());
    expect(after).toEqual({ default_affiliate_id: shopA, fulfillment: "shipping", needs_setup: false });

    const second = await order(created.id, "pickup");
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: second, p_affiliate: shopB }));
    expect(await must(admin.from("customer_locations").select("default_affiliate_id, fulfillment, needs_setup").eq("id", created.id).single())).toEqual(after);
  });

  it("an unspecified order fulfillment keeps the location's pickup", async () => {
    const created = await must(admin.rpc("qbo_location_sync_create", { p_location: site(531) }));
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: await order(created.id, "unspecified"), p_affiliate: shopB }));
    expect(await must(admin.from("customer_locations").select("default_affiliate_id, fulfillment, needs_setup").eq("id", created.id).single())).toEqual({
      default_affiliate_id: shopB,
      fulfillment: "pickup",
      needs_setup: false,
    });
  });

  it("a location set up by hand is not changed by a dispatch", async () => {
    const loc = await insertOne("customer_locations", { customer_id: customer, code: `H1${SUFFIX}`, name: "Hand", address_raw: "x", fulfillment: "pickup" });
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: await order(loc.id, "shipping"), p_affiliate: shopA }));
    expect(await must(admin.from("customer_locations").select("default_affiliate_id, fulfillment").eq("id", loc.id).single())).toEqual({
      default_affiliate_id: null,
      fulfillment: "pickup",
    });
  });

  it("CDS saving a default shop on Admin > Locations clears needs_setup; other edits keep it", async () => {
    const created = await must(admin.rpc("qbo_location_sync_create", { p_location: site(532) }));
    await must(cds.client.from("customer_locations").update({ dock_note: "Gate 2" }).eq("id", created.id));
    expect((await must(admin.from("customer_locations").select("needs_setup").eq("id", created.id).single())).needs_setup).toBe(true);
    await must(cds.client.from("customer_locations").update({ default_affiliate_id: shopA }).eq("id", created.id));
    expect((await must(admin.from("customer_locations").select("needs_setup").eq("id", created.id).single())).needs_setup).toBe(false);
  });
});
