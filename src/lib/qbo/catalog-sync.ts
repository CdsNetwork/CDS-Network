/**
 * Catalog sync from QuickBooks (CDS 2026-11-17: a part, ENV-NOX-1632, was in QuickBooks but
 * not in the portal, whose catalog was only edited by hand). Every hour (and on "Sync now" on
 * the Catalog page) the portal reads the active QuickBooks items and:
 *
 *   a. Item already used by the portal (any qbo_item_map row, a measurement item, the shop
 *      bill deduction item): nothing new. When its QuickBooks name changed, only the stored
 *      QuickBooks name of its links is updated. Portal names and prices are never changed
 *      (CDS may have tuned them); a different SKU, Fleet Price or Shop Rate is only reported.
 *   b. Not used, and a portal item has the same SKU (QuickBooks Sku, else Name; trimmed, any
 *      case) and no default link yet: the default link (all customers) is created.
 *   c. Not used and no portal item with that SKU: a catalog item is created with its prices
 *      and the default link, when the item passes the rule below.
 *
 * Skip rule (an item that is not used and has no portal SKU match is created only when all
 * hold; otherwise it is listed in the run record with the reason):
 *   1. Active in QuickBooks ("inactive").
 *   2. Type Inventory, NonInventory or Service; never Category, Group or Bundle ("type").
 *   3. A sales price above 0 ("no_price"): items without one are vendor-only (CDS's
 *      "Shipping Credit" for shop bill deductions), $0 measurement templates or fees.
 *   4. A part number for a name ("not_a_part_number"): letters, digits and dots in at least two
 *      dash-separated parts, no spaces (ENV-NOX-1632, CDS-G-17451, SVC-DPF). QuickBooks names
 *      with spaces are CDS's per-customer services and fees ("DPF Basic Clean (Ryder)",
 *      "CDS-DPF-GESI0101 (First Student)", "Toll Charge - One Way"): the portal models those
 *      as a customer's link on Admin > QuickBooks mappings, so they are never new catalog items.
 *   5. Not a second QuickBooks item with the SKU of one created in the same run ("duplicate_sku").
 *   A SKU match whose portal item already has a default link to another QuickBooks item is
 *   reported ("sku_linked_elsewhere") and left alone.
 *   Portal items are never deleted or deactivated.
 *
 * New item (c):
 *   * sku: the QuickBooks Sku, else Name, trimmed and in upper case (as the Catalog form saves).
 *   * name: the first line of the QuickBooks sales description, else the QuickBooks name.
 *   * category: the most common category of portal items sharing the longest SKU prefix that
 *     has any (ENV-NOX-1632: ENV-NOX-..., then ENV-...); none: "service" for a QuickBooks
 *     Service item, else "part".
 *   * tax_class: "exempt" when QuickBooks says not taxable; else the most common taxable class
 *     of that same prefix group, else of the category, else labor (service) or parts.
 *   * shop_selectable, pass_through, price_per_line: the majority of portal items in that
 *     category (none: true, true, false, the column defaults).
 *   * Fleet Price (sell_prices, US, from today) = QuickBooks UnitPrice; default Shop Rate
 *     (shop_rates, US, all shops and customers, from today) = QuickBooks PurchaseCost. A price
 *     that is 0 or missing is not set (the Catalog page shows it empty, as CDS leaves it).
 *     CDS said where the price file and QuickBooks differ, QuickBooks wins; this applies to
 *     new items only, existing prices are reported, not changed.
 *
 * The planning here is pure (no QuickBooks, no database); ./catalog-sync-server does the IO.
 */
import { dateTime } from "@/lib/format";
import { QboError } from "./client";

export const SYNC_ITEM_TYPES = ["Inventory", "NonInventory", "Service"] as const;

/** Item fields read from QuickBooks (https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/item). */
export type QboCatalogItem = {
  Id: string;
  Name: string;
  Sku?: string;
  Description?: string;
  Type?: string;
  Active?: boolean;
  Taxable?: boolean;
  UnitPrice?: number;
  PurchaseCost?: number;
};

export type Category = "service" | "part" | "clamp" | "bung" | "gasket";
export type TaxClass = "parts" | "labor" | "shipping" | "exempt";

export type PortalCatalogItem = {
  id: string;
  sku: string;
  category: Category | string;
  name: string;
  tax_class: TaxClass | string;
  shop_selectable: boolean;
  pass_through: boolean;
  price_per_line: boolean;
  /** Current Fleet Price (US). */
  sellPrice: number | null;
  /** Current default Shop Rate (US, all shops and customers). */
  shopRate: number | null;
};

/** A qbo_item_map row. customerId null: the default link (all customers). */
export type PortalLink = { catalogItemId: string; qboItemId: string; qboItemName: string; customerId: string | null };

export type NewCatalogItem = {
  sku: string;
  name: string;
  category: Category;
  tax_class: TaxClass;
  shop_selectable: boolean;
  pass_through: boolean;
  price_per_line: boolean;
  sell_price: number | null;
  shop_rate: number | null;
  qbo_item_id: string;
  qbo_item_name: string;
};

export type PlannedLink = { catalogItemId: string; sku: string; qboItemId: string; qboItemName: string };
export type PlannedRename = { qboItemId: string; from: string; to: string };
export type Difference = { sku: string; qboItemId: string; field: "sku" | "fleet_price" | "shop_rate"; portal: string | number | null; qbo: string | number };
export type SkipReason = "inactive" | "type" | "no_price" | "not_a_part_number" | "sku_linked_elsewhere" | "duplicate_sku";
export type Skipped = { qboItemId: string; name: string; reason: SkipReason };

export type CatalogSyncPlan = {
  creates: NewCatalogItem[];
  links: PlannedLink[];
  renames: PlannedRename[];
  differences: Difference[];
  skipped: Skipped[];
  /** Items already used by the portal (nothing to do beyond a rename). */
  unchanged: number;
};

export type CatalogSyncInput = {
  qboItems: QboCatalogItem[];
  catalog: PortalCatalogItem[];
  links: PortalLink[];
  /** QuickBooks item ids the portal uses outside qbo_item_map (measurement items, the bill deduction item). */
  reservedQboIds: string[];
};

const CATEGORIES: Category[] = ["service", "part", "clamp", "bung", "gasket"];
const NAME_MAX = 200;
const SKU_MAX = 100;

const key = (s: string | undefined | null) => (s ?? "").trim().toUpperCase();

/** A dash-separated code without spaces: ENV-NOX-1632, CDS-G-17451, SVC-DPF. */
export function looksLikePartNumber(value: string): boolean {
  const v = value.trim();
  return v.length <= SKU_MAX && /^[A-Za-z0-9.]+(-[A-Za-z0-9.]+)+$/.test(v);
}

/** The SKU QuickBooks gives an item: its Sku field, else its name. */
export function qboSku(item: QboCatalogItem): string {
  return (item.Sku ?? "").trim() || item.Name.trim();
}

/** Prefixes of a SKU, longest first, without the SKU itself: CDS-KIT-ISZ-01 -> CDS-KIT-ISZ, CDS-KIT, CDS. */
export function skuPrefixes(sku: string): string[] {
  const parts = key(sku).split("-");
  const out: string[] = [];
  for (let n = parts.length - 1; n >= 1; n--) out.push(parts.slice(0, n).join("-"));
  return out;
}

/** Portal items sharing the longest SKU prefix that has any. */
function prefixGroup(sku: string, catalog: PortalCatalogItem[]): PortalCatalogItem[] {
  for (const p of skuPrefixes(sku)) {
    const group = catalog.filter((i) => key(i.sku).startsWith(`${p}-`));
    if (group.length) return group;
  }
  return [];
}

/** The most common value; ties go to the first in `order`. */
function mostCommon<T extends string>(values: string[], order: readonly T[]): T | null {
  let best: T | null = null;
  let bestCount = 0;
  for (const v of order) {
    const n = values.filter((x) => x === v).length;
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

function majority(values: boolean[], fallback: boolean): boolean {
  if (!values.length) return fallback;
  const yes = values.filter(Boolean).length;
  return yes * 2 === values.length ? fallback : yes * 2 > values.length;
}

export function inferCategory(sku: string, qboType: string | undefined, catalog: PortalCatalogItem[]): Category {
  const fromPrefix = mostCommon(
    prefixGroup(sku, catalog).map((i) => i.category),
    CATEGORIES,
  );
  return fromPrefix ?? (qboType === "Service" ? "service" : "part");
}

function inferTaxClass(item: QboCatalogItem, sku: string, category: Category, catalog: PortalCatalogItem[]): TaxClass {
  if (item.Taxable === false) return "exempt";
  const taxable = ["parts", "labor", "shipping"] as const;
  return (
    mostCommon(
      prefixGroup(sku, catalog).map((i) => i.tax_class),
      taxable,
    ) ??
    mostCommon(
      catalog.filter((i) => i.category === category).map((i) => i.tax_class),
      taxable,
    ) ??
    (category === "service" ? "labor" : "parts")
  );
}

/** The first line of the sales description, else the name; spaces collapsed, at most 200 characters. */
export function newItemName(item: Pick<QboCatalogItem, "Name" | "Description"> & { Id?: string }): string {
  const first = (item.Description ?? "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean);
  return (first || item.Name.trim()).slice(0, NAME_MAX);
}

/** A price above 0 in cents, or null. */
function price(v: number | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const cents = Math.round(v * 100) / 100;
  return cents > 0 ? cents : null;
}

const samePrice = (a: number | null, b: number) => a !== null && Math.round(a * 100) === Math.round(b * 100);

export function planCatalogSync(input: CatalogSyncInput): CatalogSyncPlan {
  const plan: CatalogSyncPlan = { creates: [], links: [], renames: [], differences: [], skipped: [], unchanged: 0 };
  const byId = new Map(input.catalog.map((i) => [i.id, i]));
  const bySku = new Map(input.catalog.map((i) => [key(i.sku), i]));
  const used = new Set([...input.links.map((l) => l.qboItemId), ...input.reservedQboIds]);
  const defaultLink = new Map(input.links.filter((l) => l.customerId === null).map((l) => [l.catalogItemId, l]));
  const takenSkus = new Set<string>();
  const linkedItems = new Set<string>();

  for (const q of input.qboItems) {
    const name = q.Name.trim();
    const sku = qboSku(q);

    if (used.has(q.Id)) {
      plan.unchanged++;
      const links = input.links.filter((l) => l.qboItemId === q.Id);
      const stale = links.find((l) => l.qboItemName !== name);
      if (stale && name) plan.renames.push({ qboItemId: q.Id, from: stale.qboItemName, to: name });
      for (const l of links.filter((x) => x.customerId === null)) {
        const portal = byId.get(l.catalogItemId);
        if (!portal) continue;
        if (key(portal.sku) !== key(sku) && key(portal.sku) !== key(name)) {
          plan.differences.push({ sku: portal.sku, qboItemId: q.Id, field: "sku", portal: portal.sku, qbo: sku });
        }
        const sell = price(q.UnitPrice);
        if (sell !== null && !samePrice(portal.sellPrice, sell)) {
          plan.differences.push({ sku: portal.sku, qboItemId: q.Id, field: "fleet_price", portal: portal.sellPrice, qbo: sell });
        }
        const rate = price(q.PurchaseCost);
        if (rate !== null && !samePrice(portal.shopRate, rate)) {
          plan.differences.push({ sku: portal.sku, qboItemId: q.Id, field: "shop_rate", portal: portal.shopRate, qbo: rate });
        }
      }
      continue;
    }

    const skip = (reason: SkipReason) => plan.skipped.push({ qboItemId: q.Id, name, reason });
    if (q.Active === false) {
      skip("inactive");
      continue;
    }
    if (!SYNC_ITEM_TYPES.includes((q.Type ?? "") as (typeof SYNC_ITEM_TYPES)[number])) {
      skip("type");
      continue;
    }

    const match = [key(q.Sku), key(name)].filter(Boolean).map((k) => bySku.get(k)).find(Boolean);
    if (match) {
      if (defaultLink.has(match.id) || linkedItems.has(match.id)) {
        skip("sku_linked_elsewhere");
      } else {
        plan.links.push({ catalogItemId: match.id, sku: match.sku, qboItemId: q.Id, qboItemName: name });
        linkedItems.add(match.id);
      }
      continue;
    }

    const sell = price(q.UnitPrice);
    if (sell === null) {
      skip("no_price");
      continue;
    }
    if (!looksLikePartNumber(sku)) {
      skip("not_a_part_number");
      continue;
    }
    const newSku = key(sku);
    if (takenSkus.has(newSku)) {
      skip("duplicate_sku");
      continue;
    }
    takenSkus.add(newSku);

    const category = inferCategory(newSku, q.Type, input.catalog);
    const sameCategory = input.catalog.filter((i) => i.category === category);
    plan.creates.push({
      sku: newSku,
      name: newItemName(q),
      category,
      tax_class: inferTaxClass(q, newSku, category, input.catalog),
      shop_selectable: majority(
        sameCategory.map((i) => i.shop_selectable),
        true,
      ),
      pass_through: majority(
        sameCategory.map((i) => i.pass_through),
        true,
      ),
      price_per_line: majority(
        sameCategory.map((i) => i.price_per_line),
        false,
      ),
      sell_price: sell,
      shop_rate: price(q.PurchaseCost),
      qbo_item_id: q.Id,
      qbo_item_name: name,
    });
  }
  return plan;
}

// ---------------------------------------------------------------- run

export type CatalogSyncTrigger = "cron" | "manual";

export type CatalogSyncDetails = {
  created?: { sku: string; qbo_item_id: string }[];
  linked?: { sku: string; qbo_item_id: string }[];
  renamed?: PlannedRename[];
  differences?: Difference[];
  skipped?: Skipped[];
  errors?: string[];
};

/** One row of qbo_catalog_sync_runs (without its id and timestamps). */
export type CatalogSyncRunRecord = {
  trigger: CatalogSyncTrigger;
  status: "ok" | "failed";
  started_at: string;
  qbo_items: number;
  created: number;
  linked: number;
  renamed: number;
  skipped: number;
  differences: number;
  details: CatalogSyncDetails;
  error: string | null;
};

export type CatalogSyncDeps = {
  /** Active QuickBooks items. Throws a QboError of type "Config" when QuickBooks is not connected. */
  listQboItems(): Promise<QboCatalogItem[]>;
  loadPortal(): Promise<{ catalog: PortalCatalogItem[]; links: PortalLink[]; reservedQboIds: string[] }>;
  /** Creates the item, its prices and its default link at once; created false when the SKU exists already. */
  createItem(item: NewCatalogItem): Promise<{ id: string; created: boolean }>;
  /** Creates the default link; false when the item has one already. */
  link(link: PlannedLink): Promise<boolean>;
  rename(rename: PlannedRename): Promise<void>;
  recordRun(run: CatalogSyncRunRecord): Promise<void>;
  now(): Date;
};

export type CatalogSyncResult =
  | { status: "skipped"; reason: string }
  | { status: "dry_run"; created: number; linked: number; renamed: number; skipped: number; differences: number; plan: CatalogSyncPlan }
  | {
      status: "ok" | "failed";
      created: number;
      linked: number;
      renamed: number;
      skipped: number;
      differences: number;
      error?: string;
    };

/** Details are kept small: at most this many entries per list. */
const DETAIL_MAX = 200;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One run. `dryRun`: read QuickBooks and the portal and return the plan; nothing is written or
 * recorded (to preview what a first run would add).
 */
export async function runCatalogSync(
  deps: CatalogSyncDeps,
  trigger: CatalogSyncTrigger,
  options: { dryRun?: boolean } = {},
): Promise<CatalogSyncResult> {
  const startedAt = deps.now().toISOString();
  let qboItems: QboCatalogItem[];
  try {
    qboItems = await deps.listQboItems();
  } catch (e) {
    if (e instanceof QboError && e.faultType === "Config") return { status: "skipped", reason: e.message };
    const error = message(e).slice(0, 2000);
    if (options.dryRun) return { status: "failed", created: 0, linked: 0, renamed: 0, skipped: 0, differences: 0, error };
    await deps.recordRun({
      trigger,
      status: "failed",
      started_at: startedAt,
      qbo_items: 0,
      created: 0,
      linked: 0,
      renamed: 0,
      skipped: 0,
      differences: 0,
      details: {},
      error,
    });
    return { status: "failed", created: 0, linked: 0, renamed: 0, skipped: 0, differences: 0, error };
  }

  const errors: string[] = [];
  const created: { sku: string; qbo_item_id: string }[] = [];
  const linked: { sku: string; qbo_item_id: string }[] = [];
  const renamed: PlannedRename[] = [];
  let plan: CatalogSyncPlan = { creates: [], links: [], renames: [], differences: [], skipped: [], unchanged: 0 };
  if (options.dryRun) {
    plan = planCatalogSync({ qboItems, ...(await deps.loadPortal()) });
    return {
      status: "dry_run",
      created: plan.creates.length,
      linked: plan.links.length,
      renamed: plan.renames.length,
      skipped: plan.skipped.length,
      differences: plan.differences.length,
      plan,
    };
  }
  try {
    plan = planCatalogSync({ qboItems, ...(await deps.loadPortal()) });
    for (const c of plan.creates) {
      try {
        if ((await deps.createItem(c)).created) created.push({ sku: c.sku, qbo_item_id: c.qbo_item_id });
      } catch (e) {
        errors.push(`${c.sku}: ${message(e)}`);
      }
    }
    for (const l of plan.links) {
      try {
        if (await deps.link(l)) linked.push({ sku: l.sku, qbo_item_id: l.qboItemId });
      } catch (e) {
        errors.push(`${l.sku}: ${message(e)}`);
      }
    }
    for (const r of plan.renames) {
      try {
        await deps.rename(r);
        renamed.push(r);
      } catch (e) {
        errors.push(`${r.to}: ${message(e)}`);
      }
    }
  } catch (e) {
    errors.push(message(e));
  }

  const status = errors.length ? "failed" : "ok";
  const error = errors.length ? errors.join("; ").slice(0, 2000) : null;
  const record: CatalogSyncRunRecord = {
    trigger,
    status,
    started_at: startedAt,
    qbo_items: qboItems.length,
    created: created.length,
    linked: linked.length,
    renamed: renamed.length,
    skipped: plan.skipped.length,
    differences: plan.differences.length,
    details: {
      created: created.slice(0, DETAIL_MAX),
      linked: linked.slice(0, DETAIL_MAX),
      renamed: renamed.slice(0, DETAIL_MAX),
      differences: plan.differences.slice(0, DETAIL_MAX),
      skipped: plan.skipped.slice(0, DETAIL_MAX),
      ...(errors.length ? { errors: errors.slice(0, DETAIL_MAX) } : {}),
    },
    error,
  };
  await deps.recordRun(record);
  return {
    status,
    created: record.created,
    linked: record.linked,
    renamed: record.renamed,
    skipped: record.skipped,
    differences: record.differences,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------- status line

export type CatalogSyncRunRow = {
  finished_at: string;
  status: string;
  created: number;
  linked: number;
  error: string | null;
  details: CatalogSyncDetails | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The Catalog page's one status line, from the latest runs (newest first): the last
 * successful run and its new items, and the error of the latest run when it failed.
 */
export function catalogSyncStatus(runs: CatalogSyncRunRow[]): { text: string; error: string | null } {
  const latest = runs[0];
  const error = latest && latest.status !== "ok" ? `The last QuickBooks sync failed (${dateTime(latest.finished_at)}): ${latest.error ?? "unknown error"}` : null;
  const ok = runs.find((r) => r.status === "ok");
  if (!ok) return { text: "Not synced from QuickBooks yet.", error };
  const skus = (ok.details?.created ?? []).map((c) => c.sku);
  const shown = skus.slice(0, 5).join(", ");
  const more = skus.length > 5 ? ` and ${skus.length - 5} more` : "";
  const created = ok.created > 0 ? `${plural(ok.created, "new item", "new items")}${shown ? ` (${shown}${more})` : ""}` : "no new items";
  const linked = ok.linked > 0 ? `, ${ok.linked} linked by SKU` : "";
  return { text: `Last synced from QuickBooks: ${dateTime(ok.finished_at)}, ${created}${linked}.`, error };
}
