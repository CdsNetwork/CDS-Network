/**
 * Sales tax rules, shared by the work order page and the QuickBooks invoice so the two can
 * never disagree.
 *
 * A line is taxable when the order taxes its class (work_order_internal flags) and the
 * customer is not tax exempt (customer_billing.tax_exempt). An exempt customer pays no sales
 * tax on any line, whatever the order's flags say.
 */

export type TaxClass = "parts" | "labor" | "shipping" | "exempt";

export type TaxFlags = {
  /** The work order's tax flags (work_order_internal). */
  taxParts: boolean;
  taxLabor: boolean;
  taxShipping: boolean;
  /** customer_billing.tax_exempt: every line is non-taxable. */
  customerTaxExempt: boolean;
};

export const CUSTOMER_EXEMPT_LABEL = "Not taxable (customer exempt)";

/** Orders whose tax is final: they keep the tax settings stored on them. */
export const TAX_FROZEN_STATUSES = ["invoiced", "cancelled"];

/**
 * Whether the order is treated as customer exempt. Open orders follow the customer's
 * current exemption. Invoiced and cancelled orders never change: their stored settings
 * decide (tax_source "customer_exempt" when the customer was exempt at the time).
 */
export function orderTaxExempt(o: { status: string; customerTaxExempt: boolean; taxSource: string | null }): boolean {
  if (TAX_FROZEN_STATUSES.includes(o.status)) return o.taxSource === "customer_exempt";
  return o.customerTaxExempt;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function isTaxable(taxClass: TaxClass | string, flags: TaxFlags): boolean {
  if (flags.customerTaxExempt) return false;
  switch (taxClass) {
    case "parts":
      return flags.taxParts;
    case "labor":
      return flags.taxLabor;
    case "shipping":
      return flags.taxShipping;
    default:
      return false;
  }
}

/** What the work order page shows under a line's tax class. */
export function taxLabel(taxClass: TaxClass | string, flags: TaxFlags): string {
  if (flags.customerTaxExempt) return CUSTOMER_EXEMPT_LABEL;
  return isTaxable(taxClass, flags) ? "Taxable" : "Non-taxable";
}

export type TaxSummary = { subtotal: number; taxable: number; salesTax: number; total: number };

/**
 * Subtotal, taxable amount, sales tax and total for the customer invoice.
 *
 * @param ratePercent the order's sales tax rate in percent (5.75 = 5.75%)
 */
export function taxSummary(
  lines: { amount: number; taxClass: TaxClass | string | null }[],
  flags: TaxFlags,
  ratePercent: number,
): TaxSummary {
  let subtotal = 0;
  let taxable = 0;
  for (const l of lines) {
    subtotal += l.amount;
    if (l.taxClass && isTaxable(l.taxClass, flags)) taxable += l.amount;
  }
  subtotal = round2(subtotal);
  taxable = round2(taxable);
  const salesTax = round2((taxable * (Number.isFinite(ratePercent) ? ratePercent : 0)) / 100);
  return { subtotal, taxable, salesTax, total: round2(subtotal + salesTax) };
}

/** The tax and total QuickBooks calculated for an invoice (Invoice.TxnTaxDetail.TotalTax, Invoice.TotalAmt). */
export type QbInvoiceAmounts = { taxTotal: number | null; total: number | null };

function amountOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? round2(v) : null;
}

/** Reads the amounts from a QuickBooks Invoice; what QuickBooks did not return is null. */
export function qbInvoiceAmounts(
  invoice: { TotalAmt?: number; TxnTaxDetail?: { TotalTax?: number } } | null | undefined,
): QbInvoiceAmounts {
  return { taxTotal: amountOrNull(invoice?.TxnTaxDetail?.TotalTax), total: amountOrNull(invoice?.TotalAmt) };
}

/**
 * What the "Customer invoice & tax" box shows for sales tax and the total. QuickBooks
 * Automated Sales Tax decides the tax (from the ship-to address), so:
 *   * once the order has a QuickBooks invoice, the box shows the tax and total QuickBooks
 *     calculated (work_order_internal.qb_tax_total, qb_total), or points to the invoice when
 *     they were not recorded;
 *   * before that, the portal's own figure (taxSummary) is labelled as an estimate, and with
 *     no rate and no jurisdiction on a taxable order it says QuickBooks calculates the tax
 *     instead of showing $0.
 * tax and total are null when the box shows text instead of an amount (taxText, totalText).
 */
export type InvoiceTaxView = {
  taxLabel: string;
  tax: number | null;
  taxText: string | null;
  totalLabel: string;
  total: number | null;
  totalText: string | null;
  note: string | null;
};

export function invoiceTaxView(o: {
  qbInvoiceId: string | null;
  qbInvoiceNumber: string | null;
  qbTaxTotal: number | null;
  qbTotal: number | null;
  customerTaxExempt: boolean;
  rate: number;
  jurisdiction: string | null;
  estimate: TaxSummary;
}): InvoiceTaxView {
  const { estimate } = o;
  if (o.qbInvoiceId) {
    const name = o.qbInvoiceNumber ?? `id ${o.qbInvoiceId}`;
    if (o.qbTaxTotal !== null) {
      return {
        taxLabel: "Sales tax (QuickBooks)",
        tax: o.qbTaxTotal,
        taxText: null,
        totalLabel: "Customer invoice total",
        total: o.qbTotal ?? round2(estimate.subtotal + o.qbTaxTotal),
        totalText: null,
        note: `From QuickBooks invoice ${name}: QuickBooks calculates the sales tax from the ship-to address.`,
      };
    }
    // Invoices created before the amounts were stored. An exempt order has no tax either way.
    if (!o.customerTaxExempt) {
      return {
        taxLabel: "Sales tax (QuickBooks)",
        tax: null,
        taxText: "See QuickBooks",
        totalLabel: "Customer invoice total",
        total: o.qbTotal,
        totalText: o.qbTotal === null ? "See QuickBooks" : null,
        note: `QuickBooks calculated the sales tax from the ship-to address; the amount was not recorded in the portal. See invoice ${name} in QuickBooks.`,
      };
    }
  }
  if (o.customerTaxExempt) {
    return {
      taxLabel: "Sales tax (customer exempt)",
      tax: 0,
      taxText: null,
      totalLabel: "Customer invoice total",
      total: estimate.subtotal,
      totalText: null,
      note: null,
    };
  }
  if (!(o.rate > 0) && !o.jurisdiction && estimate.taxable > 0) {
    return {
      taxLabel: "Estimated sales tax",
      tax: null,
      taxText: "Calculated by QuickBooks",
      totalLabel: "Customer invoice total before tax",
      total: estimate.subtotal,
      totalText: null,
      note: "QuickBooks calculates the tax when the invoice is created, from the ship-to address.",
    };
  }
  return {
    taxLabel: `Estimated sales tax (${o.rate}%)`,
    tax: estimate.salesTax,
    taxText: null,
    totalLabel: "Estimated customer invoice total",
    total: estimate.total,
    totalText: null,
    note: "Estimate from the tax settings below. QuickBooks calculates the final tax from the ship-to address when the invoice is created.",
  };
}
