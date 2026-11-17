/**
 * BUG (2026-11-17, Admin > Shop bills): a shop was suggested a QuickBooks vendor that only
 * shared a place name with it: "Connecticut" (West Haven, CT) got "Connecticut Department of
 * Revenue" and "Houston" (Humble, TX) got "Advanced Fleet Maintenance (Houston)". A suggestion
 * now needs the shop's whole name to be the vendor's name, or the leading words of it when
 * the shop's name has at least two words; otherwise CDS picks the vendor.
 */
import { describe, expect, it } from "vitest";
import { suggestVendor } from "@/lib/qbo/bill";

const vendors = [
  { Id: "10", DisplayName: "Connecticut Department of Revenue" },
  { Id: "11", DisplayName: "Advanced Fleet Maintenance (Houston)" },
  { Id: "12", DisplayName: "CDS Colorado Springs Inc." },
  { Id: "13", DisplayName: "Kings Truck Center Inc." },
  { Id: "14", DisplayName: "Enviromotive, Inc." },
];

describe("suggestVendor needs a strong name match", () => {
  it("suggests nothing when the shop name is only a place name inside a vendor name", () => {
    expect(suggestVendor("Connecticut", vendors)).toBeNull();
    expect(suggestVendor("Houston", vendors)).toBeNull();
  });

  it("still suggests the vendor whose name is the shop name (case, punctuation, Inc ignored)", () => {
    expect(suggestVendor("CDS Colorado Springs", vendors)?.Id).toBe("12");
    expect(suggestVendor("Kings Truck Center", vendors)?.Id).toBe("13");
    expect(suggestVendor("Enviromotive", vendors)?.Id).toBe("14");
    expect(suggestVendor("kings truck center, inc", vendors)?.Id).toBe("13");
  });

  it("does not match on a word in the middle of a vendor name", () => {
    expect(suggestVendor("Truck Center", vendors)).toBeNull();
    expect(suggestVendor("Colorado Springs", vendors)).toBeNull();
  });

  it("accepts a multi-word shop name that starts the vendor name, when only one vendor fits", () => {
    expect(suggestVendor("Kings Truck", vendors)?.Id).toBe("13");
  });
});
