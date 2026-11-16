/**
 * Lines whose item has no customer price yet (no customer price and no fleet price when the
 * line was added). The order can be created and worked on; the line shows "No price", the
 * customer totals show TBD instead of counting it as $0, and the QuickBooks invoice is refused
 * until the price is set (20261117010000_work_order_without_price.sql). Setting the fleet
 * price (Catalog) or the customer's price (Pricing) fills it in on open orders.
 */

export type LinePrice = { sku: string; qty: number; price: number | null };

/** The items without a price, each once, in line order. */
export function missingPriceSkus(lines: LinePrice[]): string[] {
  return [...new Set(lines.filter((l) => l.price === null).map((l) => l.sku))];
}

/** The customer subtotal before tax, or null (TBD) while any line has no price. */
export function customerSubtotal(lines: LinePrice[]): number | null {
  if (lines.some((l) => l.price === null)) return null;
  return Math.round(lines.reduce((sum, l) => sum + (l.price ?? 0) * l.qty, 0) * 100) / 100;
}

/** "Set a price for A, B and C before creating the invoice." */
export function setPriceMessage(skus: string[]): string {
  const names = skus.length > 1 ? `${skus.slice(0, -1).join(", ")} and ${skus[skus.length - 1]}` : (skus[0] ?? "");
  return `Set a price for ${names} before creating the invoice.`;
}
