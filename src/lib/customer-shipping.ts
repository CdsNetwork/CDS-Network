/**
 * The shipping charge on the customer's QuickBooks invoice (CDS, 2026-11-18). The database
 * computes it (view public.work_order_customer_shipping,
 * 20261119120000_customer_shipping_charge.sql): on shipped orders $28 per filter (DPF, DOC,
 * SCR) and $34 per EGR cooler (app_settings customer_shipping_rates), the parts counted as
 * the shop's shipping deduction counts them (./shop-deductions) but with CDS's in-house shop
 * included (the customer pays shipping either way), 0 for customers with
 * customer_billing.charge_shipping false (First Student), and CDS's override per order
 * (work_order_internal.customer_shipping_override) wins. CDS only: shops never read it.
 * When the order has no components, the filters sold on it are counted instead (Sarah,
 * 2026-11-18). GESi filters sold go on the QuickBooks item "Shipping & Handling Fee (G)":
 * $28 each, $150 each when the order has an overnight label.
 * This file only reads and labels it.
 */
import { money } from "@/lib/format";

export const CUSTOMER_SHIPPING_COLUMNS =
  "work_order_id, fulfillment, charge_shipping, counted_from, filters, egr_coolers, gesi_filters, overnight, filter_rate, egr_rate, gesi_unit_amount, automatic_amount, override_amount, box_amount, gesi_amount, amount";

export type CustomerShipping = {
  fulfillment: string;
  /** customer_billing.charge_shipping */
  chargeShipping: boolean;
  /** Where the box count comes from: the shop's components, the filters sold, or nothing. */
  countedFrom: "components" | "sold" | null;
  /** DPF, DOC and SCR components counted, or non-GESi filters sold. */
  filters: number;
  egrCoolers: number;
  /** GESi filters sold (the "Shipping & Handling Fee (G)" line). */
  gesiFilters: number;
  /** The order has an overnight label: the GESi rate is the overnight one. */
  overnight: boolean;
  filterRate: number;
  egrRate: number;
  /** Per GESi filter: $28, or $150 overnight. */
  gesiUnitAmount: number;
  /** What the rules give, before CDS's override. */
  automaticAmount: number;
  /** Set by CDS for this order; null = automatic. */
  overrideAmount: number | null;
  /** For the invoice's Shipping box. */
  boxAmount: number;
  /** For the "Shipping & Handling Fee (G)" line. */
  gesiAmount: number;
  /** The whole shipping charge: boxAmount + gesiAmount. */
  amount: number;
};

const num = (v: unknown) => Number(v ?? 0);

/** The view row (numeric may arrive as strings); null when there is none. */
export function toCustomerShipping(row: Record<string, unknown> | null | undefined): CustomerShipping | null {
  if (!row) return null;
  return {
    fulfillment: String(row.fulfillment ?? ""),
    chargeShipping: row.charge_shipping !== false,
    countedFrom: row.counted_from === "components" || row.counted_from === "sold" ? row.counted_from : null,
    filters: num(row.filters),
    egrCoolers: num(row.egr_coolers),
    gesiFilters: num(row.gesi_filters),
    overnight: row.overnight === true,
    filterRate: num(row.filter_rate),
    egrRate: num(row.egr_rate),
    gesiUnitAmount: num(row.gesi_unit_amount),
    automaticAmount: num(row.automatic_amount),
    overrideAmount: row.override_amount === null || row.override_amount === undefined ? null : Number(row.override_amount),
    boxAmount: num(row.box_amount),
    gesiAmount: num(row.gesi_amount),
    amount: num(row.amount),
  };
}

/** How the automatic amount came about, for the work order page. */
export function automaticShippingText(s: CustomerShipping, customerName: string): string {
  if (s.fulfillment !== "shipping" && s.fulfillment !== "supplier_direct") return "Automatic: no shipping charge, the order is not shipped.";
  if (!s.chargeShipping) return `Automatic: no shipping charge, ${customerName} is not charged shipping.`;
  const sold = s.countedFrom === "sold" ? " sold" : "";
  const box = [
    s.filters > 0 && `${s.filters} ${s.filters === 1 ? "filter" : "filters"}${sold} x ${money(s.filterRate)}`,
    s.egrCoolers > 0 && `${s.egrCoolers} EGR ${s.egrCoolers === 1 ? "cooler" : "coolers"} x ${money(s.egrRate)}`,
  ].filter(Boolean);
  const parts = [
    box.length > 0 && `${box.join(" + ")} round trip in the Shipping box`,
    s.gesiFilters > 0 &&
      `${s.gesiFilters} GESi ${s.gesiFilters === 1 ? "filter" : "filters"} x ${money(s.gesiUnitAmount)}${s.overnight ? " (overnight label)" : ""} on Shipping & Handling Fee (G)`,
  ].filter(Boolean);
  if (!parts.length) return "Automatic: no filters or EGR coolers from the shop, and no filters sold, on this order yet.";
  return `Automatic: ${parts.join(" + ")} = ${money(s.automaticAmount)}.`;
}

/** The highest amount the database accepts (customer_shipping_override_range). */
const MAX = 100000;

/** The amount CDS typed ("$45.50", "1,200", "0"). */
export function parseShippingOverride(input: string): { ok: true; amount: number } | { ok: false; error: string } {
  const t = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { ok: false, error: "Enter the shipping charge in dollars, for example 56 or 45.50 (0 for no shipping)." };
  const amount = Number(t);
  if (!(amount <= MAX)) return { ok: false, error: `The shipping charge cannot be more than ${money(MAX)}.` };
  return { ok: true, amount };
}
