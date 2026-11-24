/**
 * Automatic deductions on the shop's bill. The database computes them (view
 * public.work_order_shop_deductions, 20261111030000_shop_filter_shipping_deduction.sql and
 * 20261119050000_shipping_deduction_egr.sql): $15 per part shipped (every DPF, DOC, SCR and
 * EGR cooler component) on shipped orders, never on pickup orders or for the in-house shop.
 * An order with no components counts the filters sold on it instead (reconditioned, new and
 * GESi filters; also on supplier direct orders) while its shop bill is not in QuickBooks
 * (20261119140000_shipping_deduction_sold_filters.sql).
 * The amount per part is private.shop_shipping_deduction_per_filter() there. This file only
 * reads, labels and adds them up; it never decides them.
 *
 * Deductions are not work order lines: they have no customer price and never reach the
 * customer invoice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { money } from "@/lib/format";
import type { BillState } from "@/lib/qbo/bill";

export type ShopDeduction = {
  kind: "filter_shipping";
  /** Parts shipped: filters (DPF, DOC, SCR) and EGR coolers. The view column keeps its old name. */
  filters: number;
  /** Per part, negative. */
  unit_amount: number;
  /** Total, negative. */
  amount: number;
};

export const SHOP_DEDUCTION_COLUMNS = "work_order_id, kind, filters, unit_amount, amount";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** View rows (numeric may arrive as strings) to deductions. */
export function toShopDeductions(rows: readonly Record<string, unknown>[] | null | undefined): ShopDeduction[] {
  return (rows ?? []).map((r) => ({
    kind: r.kind as ShopDeduction["kind"],
    filters: Number(r.filters),
    unit_amount: Number(r.unit_amount),
    amount: Number(r.amount),
  }));
}

/** The deductions of one work order, as the caller's RLS allows. */
export async function loadShopDeductions(supabase: SupabaseClient, workOrderId: string): Promise<ShopDeduction[]> {
  const { data, error } = await supabase
    .from("work_order_shop_deductions")
    .select(SHOP_DEDUCTION_COLUMNS)
    .eq("work_order_id", workOrderId);
  if (error) throw new Error(error.message);
  return toShopDeductions(data as Record<string, unknown>[]);
}

/** What the shop is paid: every line at its shop rate, plus the (negative) deductions. */
export function shopPayable(
  lines: readonly { qty: number; shop_unit_rate: number | null }[],
  deductions: readonly { amount: number }[],
): number {
  const fromLines = lines.reduce((sum, l) => sum + (l.shop_unit_rate ?? 0) * l.qty, 0);
  return round2(fromLines + deductions.reduce((sum, d) => sum + d.amount, 0));
}

/**
 * True when a line has no shop rate yet (TBD: First Student's AM gaskets and clamps, items
 * priced on the order, items with no rate in the price list). The bill total is then TBD,
 * never the other lines' sum as if that line paid nothing.
 */
export function hasMissingShopRate(lines: readonly { shop_unit_rate: number | null }[]): boolean {
  return lines.some((l) => l.shop_unit_rate === null);
}

/** A shop amount for display: "TBD" while the rate is not entered. */
export function shopMoney(amount: number | null): string {
  return amount === null ? "TBD" : money(amount);
}

/** The line text shown to CDS and to the shop. */
export function deductionLabel(d: ShopDeduction): string {
  const parts = d.filters === 1 ? "1 part (filter or EGR cooler)" : `${d.filters} parts (filters or EGR coolers)`;
  return `Shared shipping deduction: ${parts} x ${money(Math.abs(d.unit_amount))} round trip`;
}

/**
 * "Shipping credit from shop" (work_order_internal.shop_shipping_credit, CDS only,
 * 20261119210000_shop_shipping_credit_toggle.sql): CDS turns the credit off on orders where
 * the shop gives none; the view then has no deduction for the order.
 */
export const SHIPPING_CREDIT_HELP = "Turn off when the shop does not give a shipping credit on this order, for example NOx sensors.";

/**
 * Why the flag cannot change now, or null when it can: the shop's bill is in QuickBooks
 * (work_order_internal.qb_bill_id, or the bill record) or is being created. The database
 * refuses the same (private.shop_shipping_credit_locked).
 */
export function shippingCreditLock(qbBillId: string | null, bill: BillState | null): string | null {
  if (qbBillId || bill?.kind === "created") return "Locked: the shop's bill is in QuickBooks.";
  if (bill?.kind === "creating") return "Locked while the shop's bill is being created. Refresh in a moment.";
  return null;
}

/**
 * Whether the Shop bill box also shows the "Shipping credit from shop" checkbox, right above
 * "Approve and send to QuickBooks" (Sarah, CDS, 2026-11-24): while the bill waits for CDS's
 * approval, for a regular shop (never the in-house shop, as under the lines), and only while the
 * flag can change (shippingCreditLock). The checkbox under the lines stays.
 */
export function shippingCreditInBillPanel(
  bill: BillState | null,
  o: { qbBillId: string | null; inHouse: boolean; hasShop: boolean; hasInternal: boolean },
): boolean {
  if (bill?.kind !== "pending_approval") return false;
  if (o.inHouse || !o.hasShop || !o.hasInternal) return false;
  return shippingCreditLock(o.qbBillId, bill) === null;
}
