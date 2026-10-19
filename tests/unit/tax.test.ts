import { describe, expect, it } from "vitest";
import { isTaxable as invoiceIsTaxable } from "@/lib/qbo/invoice";
import { isTaxable, taxLabel, taxSummary, type TaxFlags } from "@/lib/tax";

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
