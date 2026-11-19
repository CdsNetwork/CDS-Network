/**
 * A location synced from QuickBooks remembers its QuickBooks customer (CDS 2026-11-19). The
 * invoice for a work order at that location goes to that customer directly (it is the site),
 * without the site-number lookup: a sub-customer with the parent's billing address (as the
 * site-number match does), a top-level site ("Torq by Acme - Tampa") with its own. When that
 * QuickBooks customer is inactive, missing, or no longer belongs to the linked customer, the
 * invoice falls back to today's lookup with a note. Fake QuickBooks calls only; made-up names.
 */
import { describe, expect, it, vi } from "vitest";
import type { QboInvoicePayload } from "@/lib/qbo/invoice";
import { resolveInvoiceQbo, type InvoiceTarget, type QboLookups } from "@/lib/qbo/invoice-qbo";
import type { QboCustomerRecord } from "@/lib/qbo/sub-customer";

const PARENT_ID = "10";
const parent: QboCustomerRecord = {
  Id: PARENT_ID,
  DisplayName: "Acme Fleet",
  FullyQualifiedName: "Acme Fleet",
  BillAddr: { Id: "900", Line1: "PO Box 7", City: "Atlanta", CountrySubDivisionCode: "GA", PostalCode: "30301", Country: "USA" },
};
const sub = (id: string, name: string, over: Partial<QboCustomerRecord> = {}): QboCustomerRecord => ({
  Id: id,
  DisplayName: name,
  FullyQualifiedName: `Acme Fleet:${name}`,
  Job: true,
  Active: true,
  ParentRef: { value: PARENT_ID },
  ...over,
});
const customers: QboCustomerRecord[] = [
  parent,
  sub("11", "ACME - 297-PINE RIDGE CO"),
  sub("12", "ACME - 412-OAK FALLS"),
  sub("13", "ACME - 530-HARBOR", { Active: false }),
  sub("14", "ACME - 297-ELSEWHERE", { FullyQualifiedName: "Other Co:ACME - 297-ELSEWHERE", ParentRef: { value: "77" } }),
  { Id: "31", DisplayName: "Acme Fleet - Tampa", FullyQualifiedName: "Acme Fleet - Tampa", Active: true, BillAddr: { Line1: "9 Bay St", City: "Tampa" } },
];

const base = (): QboInvoicePayload => ({
  CustomerRef: { value: PARENT_ID, name: "Acme Fleet" },
  ShipAddr: { Line1: "15 Mill Rd", City: "Pine Ridge", CountrySubDivisionCode: "CO", PostalCode: "80901", Country: "US" },
  Line: [],
  PrivateNote: "Portal WO-1",
});
const target = (over: Partial<InvoiceTarget> = {}): InvoiceTarget => ({
  locationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  siteNumber: "297",
  locationName: "Pine Ridge",
  city: "Pine Ridge",
  poNumber: null,
  unitNumber: null,
  ...over,
});

function lookups(): QboLookups & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getCustomer: vi.fn(async (id: string) => {
      calls.push(`customer ${id}`);
      return customers.find((c) => c.Id === id) ?? null;
    }),
    listSubCustomers: vi.fn(async (fqn: string) => {
      calls.push(`subs ${fqn}`);
      return customers.filter((c) => c.ParentRef?.value === PARENT_ID);
    }),
    salesFormsPrefs: vi.fn(async () => null),
    recentInvoiceCustomFields: vi.fn(async () => []),
    getItems: vi.fn(async () => []),
  };
}

const PARENT_BILL = { Line1: "PO Box 7", City: "Atlanta", CountrySubDivisionCode: "GA", PostalCode: "30301", Country: "USA" };

describe("invoice to the location's QuickBooks customer", () => {
  it("bills the linked sub-customer directly with the parent's billing address, without the site-number lookup", async () => {
    const l = lookups();
    // Site number 412 would find another sub-customer: the link wins.
    const r = await resolveInvoiceQbo(l, base(), target({ siteNumber: "412", qboCustomerId: "11" }), null);
    expect(r.payload.CustomerRef).toEqual({ value: "11", name: "ACME - 297-PINE RIDGE CO" });
    expect(r.payload.BillAddr).toEqual(PARENT_BILL);
    expect(r.payload.ShipAddr?.City).toBe("Pine Ridge");
    expect(r.subCustomer).toEqual({ id: "11", name: "Acme Fleet:ACME - 297-PINE RIDGE CO" });
    expect(r.notes).toEqual([]);
    expect(l.calls.some((c) => c.startsWith("subs "))).toBe(false);
  });

  it("bills a top-level site (named after the parent) with its own billing address", async () => {
    const r = await resolveInvoiceQbo(lookups(), base(), target({ siteNumber: null, qboCustomerId: "31" }), null);
    expect(r.payload.CustomerRef).toEqual({ value: "31", name: "Acme Fleet - Tampa" });
    expect(r.payload.BillAddr).toBeUndefined();
    expect(r.notes).toEqual([]);
  });

  it("falls back to the site-number lookup with a note when the linked customer is inactive", async () => {
    const r = await resolveInvoiceQbo(lookups(), base(), target({ qboCustomerId: "13", qboCustomerName: "Acme Fleet:ACME - 530-HARBOR" }), null);
    expect(r.payload.CustomerRef.value).toBe("11");
    expect(r.notes).toEqual([
      "The location's QuickBooks customer Acme Fleet:ACME - 530-HARBOR is inactive in QuickBooks, so the sub-customer was looked up by site number.",
    ]);
  });

  it("falls back with a note when the linked customer is missing or belongs to another parent", async () => {
    const missing = await resolveInvoiceQbo(lookups(), base(), target({ qboCustomerId: "404", qboCustomerName: "Acme Fleet:GONE" }), null);
    expect(missing.payload.CustomerRef.value).toBe("11");
    expect(missing.notes).toEqual([
      "The location's QuickBooks customer Acme Fleet:GONE was not found in QuickBooks, so the sub-customer was looked up by site number.",
    ]);
    const other = await resolveInvoiceQbo(lookups(), base(), target({ qboCustomerId: "14", qboCustomerName: "Other Co:ACME - 297-ELSEWHERE" }), null);
    expect(other.payload.CustomerRef.value).toBe("11");
    expect(other.notes).toEqual([
      "The location's QuickBooks customer Other Co:ACME - 297-ELSEWHERE is not a site of Acme Fleet in QuickBooks, so the sub-customer was looked up by site number.",
    ]);
  });

  it("keeps the fallback note when the parent has no sub-customers to look up", async () => {
    const l = lookups();
    l.listSubCustomers = vi.fn(async () => []);
    const r = await resolveInvoiceQbo(l, base(), target({ qboCustomerId: "13", qboCustomerName: "X" }), null);
    expect(r.payload.CustomerRef.value).toBe(PARENT_ID);
    expect(r.notes).toEqual(["The location's QuickBooks customer X is inactive in QuickBooks, so the sub-customer was looked up by site number."]);
  });

  it("without a linked customer keeps today's behaviour", async () => {
    const r = await resolveInvoiceQbo(lookups(), base(), target(), null);
    expect(r.payload.CustomerRef).toEqual({ value: "11", name: "ACME - 297-PINE RIDGE CO" });
    expect(r.payload.BillAddr).toEqual(PARENT_BILL);
    expect(r.notes).toEqual([]);
  });
});
