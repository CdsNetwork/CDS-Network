import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pacificToday } from "@/lib/dates";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { BILL_SETTING_KEY, parseBillSetting } from "./bill";
import { QboError, qboRequest, type QboApi } from "./client";
import {
  runCatalogSync,
  type CatalogSyncDeps,
  type CatalogSyncResult,
  type CatalogSyncTrigger,
  type PortalCatalogItem,
  type PortalLink,
  type QboCatalogItem,
} from "./catalog-sync";
import { qboApi } from "./tokens";

/**
 * The IO of the catalog sync (rules in ./catalog-sync): reads the QuickBooks items and the
 * portal catalog, writes through the service-role-only functions of
 * 20261119070000_qbo_catalog_sync.sql. Used by the hourly cron and "Sync now" on the Catalog
 * page (after requireCds()).
 */

const PAGE = 1000;
/** Upper bound so a very large company cannot make a run hang (CDS has about 600 items). */
const MAX_ROWS = 10_000;

/** Every active QuickBooks item, paged (at most 1000 rows per query). */
export async function listActiveItems(api: QboApi): Promise<QboCatalogItem[]> {
  const rows: QboCatalogItem[] = [];
  for (let start = 1; start <= MAX_ROWS; start += PAGE) {
    const res = await qboRequest<{ QueryResponse?: { Item?: QboCatalogItem[] } }>(api, "GET", "query", {
      query: { query: `select * from Item where Active = true startposition ${start} maxresults ${PAGE}` },
    });
    const page = res.QueryResponse?.Item ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function readQboItems(): Promise<QboCatalogItem[]> {
  const api = await qboApi();
  try {
    return await listActiveItems(api);
  } catch (e) {
    // An access token revoked early: refresh once and read again.
    if (e instanceof QboError && e.unauthorized) return listActiveItems(await qboApi({ forceRefresh: true }));
    throw e;
  }
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function loadPortal(db: SupabaseClient): Promise<{ catalog: PortalCatalogItem[]; links: PortalLink[]; reservedQboIds: string[] }> {
  const day = pacificToday();
  const current = `effective_to.is.null,effective_to.gt.${day}`;
  type ItemRow = Omit<PortalCatalogItem, "sellPrice" | "shopRate">;
  type PriceRow = { catalog_item_id: string; amount: string | number | null };
  type MapRow = { catalog_item_id: string; qbo_item_id: string; qbo_item_name: string; customer_id: string | null };
  const [items, sells, rates, maps, measurements, setting] = await Promise.all([
    fetchAll<ItemRow>((from, to) =>
      db.from("catalog_items").select("id, sku, category, name, tax_class, shop_selectable, pass_through, price_per_line").order("id").range(from, to),
    ),
    fetchAll<PriceRow>((from, to) =>
      db
        .from("sell_prices")
        .select("catalog_item_id, amount")
        .eq("market", "US")
        .lte("effective_from", day)
        .or(current)
        .order("effective_from")
        .order("id")
        .range(from, to),
    ),
    fetchAll<PriceRow>((from, to) =>
      db
        .from("shop_rates")
        .select("catalog_item_id, amount")
        .eq("market", "US")
        .is("affiliate_id", null)
        .is("customer_id", null)
        .lte("effective_from", day)
        .or(current)
        .order("effective_from")
        .order("id")
        .range(from, to),
    ),
    fetchAll<MapRow>((from, to) => db.from("qbo_item_map").select("catalog_item_id, qbo_item_id, qbo_item_name, customer_id").order("id").range(from, to)),
    fetchAll<{ qbo_item_id: string }>((from, to) => db.from("qbo_measurement_map").select("qbo_item_id").order("id").range(from, to)),
    db.from("app_settings").select("value").eq("key", BILL_SETTING_KEY).maybeSingle(),
  ]);
  if (setting.error) throw new Error(`could not read the shop bill setting: ${setting.error.message}`);

  // Ascending order: the latest row in effect wins.
  const sell = new Map(sells.map((r) => [r.catalog_item_id, num(r.amount)]));
  const rate = new Map(rates.map((r) => [r.catalog_item_id, num(r.amount)]));
  const deduction = parseBillSetting((setting.data as { value: unknown } | null)?.value)?.deduction;
  return {
    catalog: items.map((i) => ({ ...i, sellPrice: sell.get(i.id) ?? null, shopRate: rate.get(i.id) ?? null })),
    links: maps.map((m) => ({ catalogItemId: m.catalog_item_id, qboItemId: m.qbo_item_id, qboItemName: m.qbo_item_name, customerId: m.customer_id })),
    reservedQboIds: [...measurements.map((m) => m.qbo_item_id), ...(deduction?.kind === "item" ? [deduction.id] : [])],
  };
}

export function catalogSyncDeps(db: SupabaseClient): CatalogSyncDeps {
  return {
    listQboItems: readQboItems,
    loadPortal: () => loadPortal(db),
    createItem: async (item) => {
      const { data, error } = await db.rpc("qbo_catalog_sync_create_item", { p_item: item });
      if (error) throw new Error(error.message);
      return data as { id: string; created: boolean };
    },
    link: async (l) => {
      const { data, error } = await db.rpc("qbo_catalog_sync_link", { p_catalog_item: l.catalogItemId, p_qbo_item_id: l.qboItemId, p_qbo_item_name: l.qboItemName });
      if (error) throw new Error(error.message);
      return data === true;
    },
    rename: async (r) => {
      const { error } = await db.rpc("qbo_catalog_sync_rename", { p_qbo_item_id: r.qboItemId, p_qbo_item_name: r.to });
      if (error) throw new Error(error.message);
    },
    recordRun: async (run) => {
      const { error } = await db.from("qbo_catalog_sync_runs").insert(run);
      if (error) throw new Error(`could not record the catalog sync run: ${error.message}`);
    },
    now: () => new Date(),
  };
}

/** One sync run with the service role. Never throws: a failure is returned (and logged). */
export async function syncCatalogFromQuickBooks(trigger: CatalogSyncTrigger, options: { dryRun?: boolean } = {}): Promise<CatalogSyncResult> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    return await runCatalogSync(catalogSyncDeps(createAdminClient()), trigger, options);
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    console.error(`QuickBooks catalog sync (${trigger}): ${error}`);
    return { status: "failed", created: 0, linked: 0, renamed: 0, skipped: 0, differences: 0, error };
  }
}
