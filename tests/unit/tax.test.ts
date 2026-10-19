import { describe, expect, it } from "vitest";
import { isTaxable as invoiceIsTaxable } from "@/lib/qbo/invoice";
import { isTaxable, orderTaxExempt, taxLabel, taxSummary, type TaxFlags } from "@/lib/tax";

const flags: TaxFlags = { taxParts: true, taxLabor: true, taxShipping: true, customerTaxExempt: false };
const exempt: TaxFlags = { ...flags, customerTaxExempt: true };

// BUG-M2-9: WO-100451 for Ryder (tax exempt): SVC-DPF $310 plus a gasket, 5.75% Ohio rate.
const lines = [
  { amount: 310, taxClass: "labor" as const },
  { amount: 21.77, taxClass: "parts" as const },
];

describe("BUG-M2-9: sales tax honours the customer's tax exemption", () => {
  it("a tax exempt customer pays no sales tax, whatever the order's flags say", () => {
    expect(taxSummary(lines, exempt, 5.75)).toEqual({ subtotal: 331.77, taxable: 0, salesTax: 0, total: 331.77 });
  });

  it("a taxable customer pays tax on the classes the order taxes", () => {
    expect(taxSummary(lines, flags, 5.75)).toEqual({ subtotal: 331.77, taxable: 331.77, salesTax: 19.08, total: 350.85 });
    expect(taxSummary(lines, { ...flags, taxLabor: false }, 5.75)).toEqual({
      subtotal: 331.77,
      taxable: 21.77,
      salesTax: 1.25,
      total: 333.02,
    });
  });

  it("line labels say why a line is not taxed", () => {
    expect(taxLabel("labor", exempt)).toBe("Not taxable (customer exempt)");
    expect(taxLabel("labor", flags)).toBe("Taxable");
    expect(taxLabel("labor", { ...flags, taxLabor: false })).toBe("Non-taxable");
    expect(taxLabel("exempt", flags)).toBe("Non-taxable");
  });

  it("the QuickBooks invoice uses the same rule as the work order page", () => {
    expect(invoiceIsTaxable).toBe(isTaxable);
    for (const c of ["parts", "labor", "shipping", "exempt"] as const) {
      expect(isTaxable(c, exempt)).toBe(false);
    }
    expect(isTaxable("shipping", flags)).toBe(true);
    expect(isTaxable("exempt", flags)).toBe(false);
  });
});

describe("BUG-M2-11: invoiced and cancelled orders show their stored tax, not the customer's current exemption", () => {
  it("an invoiced order taxed at 5.75% stays taxed after the customer becomes exempt", () => {
    expect(orderTaxExempt({ status: "invoiced", customerTaxExempt: true, taxSource: "state_fallback" })).toBe(false);
    expect(orderTaxExempt({ status: "cancelled", customerTaxExempt: true, taxSource: "manual" })).toBe(false);
  });

  it("an order invoiced while the customer was exempt stays exempt after the exemption is removed", () => {
    expect(orderTaxExempt({ status: "invoiced", customerTaxExempt: false, taxSource: "customer_exempt" })).toBe(true);
    expect(orderTaxExempt({ status: "cancelled", customerTaxExempt: false, taxSource: "customer_exempt" })).toBe(true);
  });

  it("open orders follow the customer's current exemption", () => {
    for (const status of ["pending_review", "in_process", "ready_to_invoice"]) {
      expect(orderTaxExempt({ status, customerTaxExempt: true, taxSource: "state_fallback" })).toBe(true);
      expect(orderTaxExempt({ status, customerTaxExempt: false, taxSource: "customer_exempt" })).toBe(false);
    }
  });

  it("the invoiced total is what was stored: $356.77 plus 5.75% = $377.28 (QA r5 example)", () => {
    const exempt = orderTaxExempt({ status: "invoiced", customerTaxExempt: true, taxSource: "state_fallback" });
    const qaLines = [
      { amount: 335, taxClass: "labor" as const },
      { amount: 21.77, taxClass: "parts" as const },
    ];
    expect(taxSummary(qaLines, { ...flags, customerTaxExempt: exempt }, 5.75).total).toBe(377.28);
  });
});
