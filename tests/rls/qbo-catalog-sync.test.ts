/**
 * Catalog sync from QuickBooks (20261119070000_qbo_catalog_sync.sql). The run record is CDS
 * only: a shop and an anonymous caller read nothing; nobody signed in writes it. Only the
 * server (service role) creates items, links and renames through the sync functions: not a
 * shop, not a CDS login directly. Creating twice creates nothing new; a default link is never
 * replaced; every write is in the change log.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 * Nothing here calls QuickBooks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const SKU = `RLS-SYNC-${runId}`;
let shopId: string;
let cds: Login;
let shop: Login;
const itemIds: string[] = [];

const newItem = (sku: string, over: Record<string, unknown> = {}) => ({
  sku,
  name: `Sync test ${sku}`,
  category: "part",
  tax_class: "parts",
  shop_selectable: true,
  pass_through: true,
  price_per_line: false,
  sell_price: 259,
  shop_rate: 189,
  qbo_item_id: `9${runId.replace(/\D/g, "").slice(0, 6) || "1"}${itemIds.length}`,
  qbo_item_name: sku,
  ...over,
});

beforeAll(async () => {
  shopId = (await must(admin.from("affiliates").insert({ short_code: `SYN-${runId}`, display_name: `Sync Shop ${runId}` }).select().single())).id;
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  const items = await must(admin.from("catalog_items").select("id").like("sku", `${SKU}%`));
  const ids = (items as { id: string }[]).map((i) => i.id);
  if (ids.length) {
    await admin.from("catalog_items").delete().in("id", ids);
    await admin.from("audit_log").delete().in("row_id", ids);
  }
  await admin.from("qbo_catalog_sync_runs").delete().eq("error", `test ${runId}`);
  await deleteLogins();
  await admin.from("affiliates").delete().eq("id", shopId);
}, 120_000);

describe("qbo_catalog_sync_runs", () => {
  it("CDS reads the run record; a shop and anon read nothing; nobody signed in writes it", async () => {
    const row = await must(
      admin
        .from("qbo_catalog_sync_runs")
        .insert({ trigger: "cron", status: "failed", started_at: new Date().toISOString(), error: `test ${runId}`, details: { created: [] } })
        .select("id")
        .single(),
    );
    const mine = await must(cds.client.from("qbo_catalog_sync_runs").select("id, status").eq("id", row.id));
    expect(mine).toEqual([{ id: row.id, status: "failed" }]);
    for (const client of [shop.client, anon()]) {
      const { data, error } = await client.from("qbo_catalog_sync_runs").select("id").limit(5);
      expect(error ? [] : data).toEqual([]);
    }
    for (const client of [cds.client, shop.client]) {
      expect((await client.from("qbo_catalog_sync_runs").insert({ trigger: "manual", status: "ok", started_at: new Date().toISOString() })).error).not.toBeNull();
      await client.from("qbo_catalog_sync_runs").update({ status: "ok" }).eq("id", row.id);
      await client.from("qbo_catalog_sync_runs").delete().eq("id", row.id);
    }
    expect((await must(admin.from("qbo_catalog_sync_runs").select("status").eq("id", row.id).single())).status).toBe("failed");
  });
});

describe("sync functions", () => {
  it("only the server can create, link or rename", async () => {
    for (const client of [cds.client, shop.client, anon()]) {
      const c = await client.rpc("qbo_catalog_sync_create_item", { p_item: newItem(`${SKU}-X`) });
      expect(c.error?.code).toBe("42501");
      const l = await client.rpc("qbo_catalog_sync_link", { p_catalog_item: "00000000-0000-0000-0000-000000000000", p_qbo_item_id: "1", p_qbo_item_name: "x" });
      expect(l.error?.code).toBe("42501");
      const r = await client.rpc("qbo_catalog_sync_rename", { p_qbo_item_id: "1", p_qbo_item_name: "x" });
      expect(r.error?.code).toBe("42501");
    }
    expect(await must(admin.from("catalog_items").select("id").eq("sku", `${SKU}-X`))).toEqual([]);
  });

  it("creates the item with its Fleet Price, default Shop Rate from today and default link, once (logged)", async () => {
    const input = newItem(`${SKU}-A`);
    const first = (await must(admin.rpc("qbo_catalog_sync_create_item", { p_item: input }))) as { id: string; created: boolean };
    expect(first.created).toBe(true);
    itemIds.push(first.id);
    const row = await must(admin.from("catalog_items").select("sku, name, category, tax_class, shop_selectable, active, pass_through, price_per_line").eq("id", first.id).single());
    expect(row).toEqual({ sku: input.sku, name: input.name, category: "part", tax_class: "parts", shop_selectable: true, active: true, pass_through: true, price_per_line: false });
    const sell = await must(admin.from("sell_prices").select("amount, market, effective_to").eq("catalog_item_id", first.id));
    expect(sell).toEqual([{ amount: 259, market: "US", effective_to: null }]);
    const rate = await must(admin.from("shop_rates").select("amount, affiliate_id, customer_id, effective_to").eq("catalog_item_id", first.id));
    expect(rate).toEqual([{ amount: 189, affiliate_id: null, customer_id: null, effective_to: null }]);
    const map = await must(admin.from("qbo_item_map").select("qbo_item_id, qbo_item_name, customer_id").eq("catalog_item_id", first.id));
    expect(map).toEqual([{ qbo_item_id: input.qbo_item_id, qbo_item_name: input.sku, customer_id: null }]);
    const log = await must(admin.from("audit_log").select("table_name, action").eq("row_id", first.id));
    expect(log).toContainEqual({ table_name: "catalog_items", action: "insert" });

    const again = (await must(admin.rpc("qbo_catalog_sync_create_item", { p_item: { ...input, sell_price: 300 } }))) as { id: string; created: boolean };
    expect(again).toEqual({ id: first.id, created: false });
    expect(await must(admin.from("sell_prices").select("amount").eq("catalog_item_id", first.id))).toEqual([{ amount: 259 }]);
    // The shop sees the new item (catalog items are shop-visible) and its default rate, never the fleet price.
    expect(await must(shop.client.from("catalog_items").select("sku").eq("id", first.id))).toEqual([{ sku: input.sku }]);
    const shopSell = await shop.client.from("sell_prices").select("amount").eq("catalog_item_id", first.id);
    expect(shopSell.error ? [] : shopSell.data).toEqual([]);
  });

  it("sets no price that is missing, and refuses bad input", async () => {
    const r = (await must(admin.rpc("qbo_catalog_sync_create_item", { p_item: newItem(`${SKU}-B`, { sell_price: null, shop_rate: null }) }))) as { id: string };
    expect(await must(admin.from("sell_prices").select("amount").eq("catalog_item_id", r.id))).toEqual([]);
    expect(await must(admin.from("shop_rates").select("amount").eq("catalog_item_id", r.id))).toEqual([]);
    expect((await admin.rpc("qbo_catalog_sync_create_item", { p_item: newItem(`${SKU}-C`, { sell_price: -1 }) })).error).not.toBeNull();
    expect((await admin.rpc("qbo_catalog_sync_create_item", { p_item: newItem(`${SKU}-D`, { category: "widget" }) })).error).not.toBeNull();
    expect((await admin.rpc("qbo_catalog_sync_create_item", { p_item: newItem("  ") })).error).not.toBeNull();
    expect(await must(admin.from("catalog_items").select("id").in("sku", [`${SKU}-C`, `${SKU}-D`]))).toEqual([]);
  });

  it("links an item without a default link, never replaces one, and renames the stored QuickBooks name", async () => {
    const item = await must(admin.from("catalog_items").insert({ sku: `${SKU}-L`, category: "part", name: "Link me", tax_class: "parts" }).select("id").single());
    const first = await must(admin.rpc("qbo_catalog_sync_link", { p_catalog_item: item.id, p_qbo_item_id: "424242", p_qbo_item_name: `${SKU}-L` }));
    expect(first).toBe(true);
    const second = await must(admin.rpc("qbo_catalog_sync_link", { p_catalog_item: item.id, p_qbo_item_id: "434343", p_qbo_item_name: "other" }));
    expect(second).toBe(false);
    expect(await must(admin.from("qbo_item_map").select("qbo_item_id").eq("catalog_item_id", item.id))).toEqual([{ qbo_item_id: "424242" }]);

    const n = await must(admin.rpc("qbo_catalog_sync_rename", { p_qbo_item_id: "424242", p_qbo_item_name: `${SKU}-L renamed` }));
    expect(n).toBe(1);
    expect(await must(admin.from("qbo_item_map").select("qbo_item_name").eq("catalog_item_id", item.id))).toEqual([{ qbo_item_name: `${SKU}-L renamed` }]);
    const log = await must(admin.from("audit_log").select("action").eq("table_name", "qbo_item_map").eq("new_data->>catalog_item_id", item.id));
    expect((log as { action: string }[]).map((l) => l.action).sort()).toEqual(["insert", "update"]);
    await admin.from("audit_log").delete().eq("table_name", "qbo_item_map").eq("new_data->>catalog_item_id", item.id);
  });
});
