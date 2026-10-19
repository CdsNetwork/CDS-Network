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
