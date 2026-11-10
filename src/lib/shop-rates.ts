/**
 * Which shop rate applies, the same rule as the database (private.shop_rate_pick in
 * 20261110020000_shop_rates_per_customer.sql). Among the rows in effect, the most specific
 * wins: this shop and this customer, then this customer (any shop), then this shop (any
 * customer), then the default. Within a level the latest start date wins. A shop or
 * customer row without an amount is skipped.
 *
 * The caller passes only rows in effect on the date (effective_from <= day < effective_to).
 */
export type ShopRateRow = {
  affiliate_id: string | null;
  customer_id: string | null;
  amount: string | number | null;
  effective_from: string;
};

export type ShopRateSource = "shop" | "customer" | "default";

function level(row: ShopRateRow): number {
  if (row.affiliate_id !== null && row.customer_id !== null) return 1;
  if (row.customer_id !== null) return 2;
  if (row.affiliate_id !== null) return 3;
  return 4;
}

export function shopRateSource(row: ShopRateRow): ShopRateSource {
  return row.affiliate_id !== null ? "shop" : row.customer_id !== null ? "customer" : "default";
}

/** The winning row for a shop (or null for any shop) on an order of a customer (or null). */
export function pickShopRate<T extends ShopRateRow>(
  rows: readonly T[],
  shop: string | null,
  customer: string | null,
): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.affiliate_id !== null && r.affiliate_id !== shop) continue;
    if (r.customer_id !== null && r.customer_id !== customer) continue;
    if (r.amount === null && level(r) !== 4) continue;
    if (
      !best ||
      level(r) < level(best) ||
      (level(r) === level(best) && r.effective_from > best.effective_from)
    ) {
      best = r;
    }
  }
  return best;
}

/** Rows grouped by catalog item, then the winning row per item. */
export function pickShopRatesByItem<T extends ShopRateRow & { catalog_item_id: string }>(
  rows: readonly T[],
  shop: string | null,
  customer: string | null,
): Map<string, T> {
  const byItem = new Map<string, T[]>();
  for (const r of rows) {
    const list = byItem.get(r.catalog_item_id);
    if (list) list.push(r);
    else byItem.set(r.catalog_item_id, [r]);
  }
  const out = new Map<string, T>();
  for (const [item, list] of byItem) {
    const best = pickShopRate(list, shop, customer);
    if (best) out.set(item, best);
  }
  return out;
}
