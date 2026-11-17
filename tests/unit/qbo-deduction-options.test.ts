import { describe, expect, it } from "vitest";
import { deductionOptions } from "@/lib/qbo/deduction-options";

// CDS (Ashley, 2026-11-17) created a vendor-side service item "Shipping Credit" in QuickBooks for
// the shipping deductions on shop bills. The picker must offer items as well as accounts.
describe("deductionOptions", () => {
  const accounts = [{ Id: "50", Name: "Freight", FullyQualifiedName: "Cost of Goods Sold:Freight", AccountType: "Cost of Goods Sold", AcctNum: "5030" }];
  const items = [
    { Id: "900", Name: "Shipping Credit", Type: "Service" },
    { Id: "901", Name: "Filter Kit", Type: "Inventory" },
    { Id: "902", Name: "Kit Bundle", Type: "Group" },
    { Id: "903", Name: "Misc Part", Type: "NonInventory" },
  ];

  it("offers service and non-inventory items next to the accounts, saved as items", () => {
    const opts = deductionOptions(accounts, items);
    const credit = opts.find((o) => o.label.startsWith("Shipping Credit"));
    expect(credit?.value).toBe("item::900::Shipping Credit");
    expect(credit?.hint).toContain("Product or service item");
    expect(opts.find((o) => o.label.startsWith("Misc Part"))?.value).toBe("item::903::Misc Part");
    expect(opts.find((o) => o.value === "account::50::Cost of Goods Sold:Freight")).toBeTruthy();
  });

  it("leaves out inventory items and bundles, which a bill line cannot use as a plain credit", () => {
    const values = deductionOptions(accounts, items).map((o) => o.value);
    expect(values.some((v) => v.startsWith("item::901"))).toBe(false);
    expect(values.some((v) => v.startsWith("item::902"))).toBe(false);
  });

  it("works without an item list", () => {
    expect(deductionOptions(accounts, null)).toHaveLength(1);
  });
});
