/**
 * Linked work orders (Sarah, CDS, 2026-11-17): CDS links a work order to another one
 * (public.work_order_links, CDS only); both pages show the link, and the two get one
 * customer invoice in QuickBooks (@/lib/qbo/invoice-combined).
 * Safe on server and client.
 */

export type LinkedOrder = { id: string; wo_number: number };

/** A WO number typed by CDS: "104101", "WO 104101", "WO-104101". Null when it is not one. */
export function parseWoNumber(raw: string): number | null {
  const digits = raw.trim().replace(/^wo\s*-?\s*/i, "");
  if (!/^\d{1,12}$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The orders shown as "Linked to" on a work order page: the one this order links to and the
 * ones that link to it, each once, by WO number.
 */
export function linkedOrders(linksTo: LinkedOrder | null, linkedFrom: LinkedOrder[]): LinkedOrder[] {
  const byId = new Map<string, LinkedOrder>();
  for (const o of [...(linksTo ? [linksTo] : []), ...linkedFrom]) byId.set(o.id, o);
  return [...byId.values()].sort((a, b) => a.wo_number - b.wo_number);
}
