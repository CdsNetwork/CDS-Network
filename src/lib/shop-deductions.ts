/**
 * Automatic deductions on the shop's bill. The database computes them (view
 * public.work_order_shop_deductions, 20261111030000_shop_filter_shipping_deduction.sql):
 * $15 per filter (DPF, DOC and SCR components) on shipped orders, never on pickup orders or
 * for the in-house shop. The amount per filter is private.shop_shipping_deduction_per_filter()
 * there. This file only reads, labels and adds them up; it never decides them.
 *
 * Deductions are not work order lines: they have no customer price and never reach the
 * customer invoice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { money } from "@/lib/format";

export type ShopDeduction = {
  kind: "filter_shipping";
  filters: number;
  /** Per filter, negative. */
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
  const filters = `${d.filters} ${d.filters === 1 ? "filter" : "filters"}`;
  return `Shared shipping deduction: ${filters} x ${money(Math.abs(d.unit_amount))} round trip`;
}
