/**
 * Ashley's requests of 2026-11-11 for the QuickBooks invoice:
 *  * bill the site's sub-customer (Ryder site 297 -> "Ryder Fleet Services:RYDER - 297-COLORADO
 *    SPRINGS CO") with the parent's billing address and the site as ship-to; fall back to the
 *    parent with a note when there is no unique sub-customer;
 *  * fill the invoice custom fields "Fleet Number" and "PO Number" (skip with a note when
 *    QuickBooks has no such field);
 *  * the customer's own invoice text for an item ("EVACUFLUSH AND BAKE DPF - RYDER") and one
 *    measurement reading per line.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildInvoicePayload,
  lineDescription,
  measurementDescription,
  type InvoiceComponent,
  type InvoiceWorkOrder,
  type QboInvoicePayload,
} from "@/lib/qbo/invoice";
import { locationSiteNumber, pickSubCustomer, type QboCustomerRecord } from "@/lib/qbo/sub-customer";
import { classicCustomFieldDefs, fillCustomFields, invoiceCustomFieldDefs } from "@/lib/qbo/custom-fields";
import { itemDescriptionKey, resolveInvoiceQbo, type InvoiceTarget, type QboLookups } from "@/lib/qbo/invoice-qbo";
import { createdNote, pendingQbInvoice } from "@/lib/qbo/pending";

const RYDER_ID = "58";
const parent: QboCustomerRecord = {
  Id: RYDER_ID,
  DisplayName: "Ryder Fleet Services",
  FullyQualifiedName: "Ryder Fleet Services",
  BillAddr: { Id: "900", Line1: "PO Box 105366", City: "Atlanta", CountrySubDivisionCode: "GA", PostalCode: "30348-5366", Country: "USA" },
};
const sub = (id: string, name: string, over: Partial<QboCustomerRecord> = {}): QboCustomerRecord => ({
  Id: id,
  DisplayName: name,
  FullyQualifiedName: `Ryder Fleet Services:${name}`,
  Job: true,
  Active: true,
  ParentRef: { value: RYDER_ID },
  ...over,
});
const subs = [
  sub("301", "RYDER - 297-COLORADO SPRINGS CO"),
  sub("302", "RYDER - 2970-SOMEWHERE"),
  sub("303", "1359-NEIER INDY"),
  sub("304", "RYDER - 1083-ACADIANA BOTTLING"),
  sub("305", "Ryder - 1083-YOUNGSVILLE"),
  sub("306", "RYDER - 245-54TH STREET"),
];

const basePayload = (): QboInvoicePayload => ({
  CustomerRef: { value: RYDER_ID, name: "Ryder Fleet Services" },
  ShipAddr: { Line1: "1 Site Rd", City: "Colorado Springs", CountrySubDivisionCode: "CO", PostalCode: "80901", Country: "US" },
  Line: [],
  PrivateNote: "Portal WO-101951 | PO 4500",
});
const target = (over: Partial<InvoiceTarget> = {}): InvoiceTarget => ({
  locationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  siteNumber: "297",
  locationName: "Colorado Springs",
  city: "Colorado Springs",
  poNumber: "4500",
  unitNumber: "TRK 77",
  ...over,
});

function lookups(over: Partial<QboLookups> = {}): QboLookups & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getCustomer: vi.fn(async (id: string) => {
      calls.push(`customer ${id}`);
      return id === RYDER_ID ? parent : (subs.find((s) => s.Id === id) ?? null);
    }),
    listSubCustomers: vi.fn(async (fqn: string) => {
      calls.push(`subs ${fqn}`);
      return subs;
    }),
    salesFormsPrefs: vi.fn(async () => ({
      CustomField: [
        {
          CustomField: [
            { Name: "SalesFormsPrefs.UseSalesCustom1", Type: "BooleanType", BooleanValue: true },
            { Name: "SalesFormsPrefs.UseSalesCustom2", Type: "BooleanType", BooleanValue: true },
            { Name: "SalesFormsPrefs.UseSalesCustom3", Type: "BooleanType", BooleanValue: false },
          ],
        },
        {
          CustomField: [
            { Name: "SalesFormsPrefs.SalesCustomName1", Type: "StringType", StringValue: "Fleet Number" },
            { Name: "SalesFormsPrefs.SalesCustomName2", Type: "StringType", StringValue: "PO Number" },
            { Name: "SalesFormsPrefs.SalesCustomName3", Type: "StringType", StringValue: "Old field" },
          ],
        },
      ],
    })),
    recentInvoiceCustomFields: vi.fn(async () => []),
    getItems: vi.fn(async () => []),
    ...over,
  };
}

describe("site number", () => {
  it("is the first number of the location number, else of the code, without leading zeros", () => {
    expect(locationSiteNumber("297", "RYD-297")).toBe("297");
    expect(locationSiteNumber(null, "RYD-0297")).toBe("297");
    expect(locationSiteNumber("", "HQ")).toBeNull();
  });
});

describe("pickSubCustomer", () => {
  it("finds the Ryder site by its number, not a longer number that starts the same", () => {
    const m = pickSubCustomer(subs, RYDER_ID, "297");
    expect(m).toEqual({ kind: "match", customer: subs[0] });
  });

  it("matches names without the RYDER prefix and ignores later numbers in the name", () => {
    expect(pickSubCustomer(subs, RYDER_ID, "1359")).toMatchObject({ kind: "match", customer: { Id: "303" } });
    expect(pickSubCustomer(subs, RYDER_ID, "245")).toMatchObject({ kind: "match", customer: { Id: "306" } });
    expect(pickSubCustomer(subs, RYDER_ID, "54")).toEqual({ kind: "none" });
  });

  it("takes only direct, active children of the parent", () => {
    const other = [sub("400", "RYDER - 297-X", { ParentRef: { value: "99" } }), sub("401", "RYDER - 297-Y", { Active: false })];
    expect(pickSubCustomer(other, RYDER_ID, "297")).toEqual({ kind: "none" });
  });

  it("uses the location name to choose between two sites with the same number, else reports both", () => {
    expect(pickSubCustomer(subs, RYDER_ID, "1083", { name: "Youngsville", city: "Youngsville" })).toMatchObject({
      kind: "match",
      customer: { Id: "305" },
    });
    const amb = pickSubCustomer(subs, RYDER_ID, "1083", { name: "Lafayette" });
    expect(amb.kind).toBe("ambiguous");
    if (amb.kind === "ambiguous") expect(amb.names).toHaveLength(2);
  });
});

describe("custom field definitions", () => {
  it("reads the named, turned-on classic fields from Preferences with DefinitionId 1 to 3", async () => {
    const prefs = await lookups().salesFormsPrefs();
    expect(classicCustomFieldDefs(prefs)).toEqual([
      { id: "1", name: "Fleet Number", classic: true },
      { id: "2", name: "PO Number", classic: true },
    ]);
  });

  it("learns newer custom fields from existing invoices", () => {
    expect(
      invoiceCustomFieldDefs([
        { CustomField: [{ DefinitionId: "1149622", Name: "Fleet Number" }] },
        { CustomField: [{ DefinitionId: "1149623", Name: "PO Number" }, { DefinitionId: "9", Name: "fleet number" }] },
      ]),
    ).toEqual([
      { id: "1149622", name: "Fleet Number", classic: false },
      { id: "1149623", name: "PO Number", classic: false },
    ]);
  });

  it("fills the fields that exist, by name regardless of case, and reports the others", () => {
    const r = fillCustomFields([{ id: "1", name: "fleet number", classic: true }], [
      { name: "Fleet Number", value: " TRK 77 " },
      { name: "PO Number", value: "4500" },
      { name: "Other", value: "" },
    ]);
    expect(r.fields).toEqual([{ DefinitionId: "1", Name: "fleet number", Type: "StringType", StringValue: "TRK 77" }]);
    expect(r.missing).toEqual(["PO Number"]);
  });

  it("cuts a classic value to 31 characters and says so", () => {
    const r = fillCustomFields([{ id: "2", name: "PO Number", classic: true }], [{ name: "PO Number", value: "P".repeat(40) }]);
    expect(r.fields[0].StringValue).toHaveLength(31);
    expect(r.clipped).toEqual(["PO Number"]);
  });
});

describe("resolveInvoiceQbo", () => {
  it("bills the Ryder site's sub-customer with the parent's billing address and keeps the site as ship-to", async () => {
    const l = lookups();
    const r = await resolveInvoiceQbo(l, basePayload(), target(), null);
    expect(r.payload.CustomerRef).toEqual({ value: "301", name: "RYDER - 297-COLORADO SPRINGS CO" });
    expect(r.payload.BillAddr).toEqual({
      Line1: "PO Box 105366",
      City: "Atlanta",
      CountrySubDivisionCode: "GA",
      PostalCode: "30348-5366",
      Country: "USA",
    });
    expect(r.payload.ShipAddr).toEqual(basePayload().ShipAddr);
    expect(r.subCustomer).toEqual({ id: "301", name: "Ryder Fleet Services:RYDER - 297-COLORADO SPRINGS CO" });
    expect(r.notes).toEqual([]);
    expect(l.listSubCustomers).toHaveBeenCalledWith("Ryder Fleet Services");
  });

  it("uses a cached sub-customer after checking it still belongs to the parent, without listing all sites", async () => {
    const l = lookups();
    const r = await resolveInvoiceQbo(l, basePayload(), target(), "301");
    expect(r.payload.CustomerRef.value).toBe("301");
    expect(l.listSubCustomers).not.toHaveBeenCalled();

    const moved = lookups({ getCustomer: vi.fn(async (id: string) => (id === RYDER_ID ? parent : sub("301", "RYDER - 297-X", { ParentRef: { value: "77" } }))) });
    const r2 = await resolveInvoiceQbo(moved, basePayload(), target(), "301");
    expect(moved.listSubCustomers).toHaveBeenCalled();
    expect(r2.payload.CustomerRef.value).toBe("301");
  });

  it("falls back to the parent and says so when no sub-customer has the site number", async () => {
    const r = await resolveInvoiceQbo(lookups(), basePayload(), target({ siteNumber: "999" }), null);
    expect(r.payload.CustomerRef).toEqual({ value: RYDER_ID, name: "Ryder Fleet Services" });
    expect(r.payload).not.toHaveProperty("BillAddr");
    expect(r.subCustomer).toBeNull();
    expect(r.notes.join(" ")).toMatch(/No QuickBooks sub-customer of Ryder Fleet Services has site number 999.*billed to Ryder Fleet Services/);
  });

  it("falls back with a note naming both when two sub-customers share the number", async () => {
    const r = await resolveInvoiceQbo(lookups(), basePayload(), target({ siteNumber: "1083", locationName: "Lafayette", city: "Lafayette" }), null);
    expect(r.payload.CustomerRef.value).toBe(RYDER_ID);
    expect(r.notes.join(" ")).toMatch(/ACADIANA BOTTLING.*YOUNGSVILLE/);
  });

  it("changes nothing and says nothing for a customer without sub-customers", async () => {
    const l = lookups({ listSubCustomers: vi.fn(async () => []) });
    const r = await resolveInvoiceQbo(l, basePayload(), target(), null);
    expect(r.payload.CustomerRef.value).toBe(RYDER_ID);
    expect(r.notes.filter((n) => /sub-customer/.test(n))).toEqual([]);
  });

  it("never fails the invoice when QuickBooks lookups fail: parent and no custom fields, with notes", async () => {
    const boom = vi.fn(async () => {
      throw new Error("timeout");
    });
    const r = await resolveInvoiceQbo(
      lookups({ getCustomer: boom, salesFormsPrefs: boom, recentInvoiceCustomFields: boom }),
      basePayload(),
      target(),
      null,
    );
    expect(r.payload.CustomerRef.value).toBe(RYDER_ID);
    expect(r.payload).not.toHaveProperty("CustomField");
    expect(r.notes.length).toBe(2);
    expect(r.notes.join(" ")).toMatch(/timeout/);
  });

  it("fills Fleet Number and PO Number from the work order", async () => {
    const r = await resolveInvoiceQbo(lookups(), basePayload(), target(), null);
    expect(r.payload.CustomField).toEqual([
      { DefinitionId: "1", Name: "Fleet Number", Type: "StringType", StringValue: "TRK 77" },
      { DefinitionId: "2", Name: "PO Number", Type: "StringType", StringValue: "4500" },
    ]);
  });

  it("looks for newer custom fields on recent invoices when Preferences does not have them", async () => {
    const l = lookups({
      salesFormsPrefs: vi.fn(async () => ({})),
      recentInvoiceCustomFields: vi.fn(async () => [{ CustomField: [{ DefinitionId: "1149622", Name: "Fleet Number" }] }]),
    });
    const r = await resolveInvoiceQbo(l, basePayload(), target(), null);
    expect(r.payload.CustomField).toEqual([{ DefinitionId: "1149622", Name: "Fleet Number", Type: "StringType", StringValue: "TRK 77" }]);
    expect(r.notes).toEqual([expect.stringMatching(/no invoice custom field named "PO Number"/)]);
  });

  it("does not ask QuickBooks for custom fields when the work order has no fleet number or PO", async () => {
    const l = lookups();
    const r = await resolveInvoiceQbo(l, basePayload(), target({ poNumber: null, unitNumber: "  " }), null);
    expect(l.salesFormsPrefs).not.toHaveBeenCalled();
    expect(r.payload).not.toHaveProperty("CustomField");
  });
});

describe("invoice descriptions", () => {
  const evacu =
    "Place Diesel Particulate Filter (DPF) in EvacuBlast cabinet, test differential pressure for restriction, weigh filter, wash filter using aqueous procedure, place plugged filter in Bake oven for regeneration, perform evacublast cleaning, retest differential pressure to ensure proper flow rate, weigh the filter again to determine how much soot was removed.";

  it("matches QuickBooks item names regardless of case and spacing", () => {
    expect(itemDescriptionKey("EVACUFLUSH AND BAKE DPF - RYDER")).toBe(itemDescriptionKey(" evacuflush and bake dpf-ryder "));
  });

  it("uses the QuickBooks item's invoice text instead of our item name", () => {
    expect(lineDescription({ name: "DPF Cleaning" }, undefined, evacu)).toBe(evacu);
    expect(lineDescription({ name: "DPF Cleaning" }, undefined, null)).toBe("DPF Cleaning");
    expect(lineDescription({ name: "DPF Cleaning" }, { partNumber: "FS-1", description: "Their text" }, evacu)).toBe(
      "Part # FS-1 - Their text",
    );
  });

  it("puts the invoice text of the mapped item on the line", () => {
    const wo: InvoiceWorkOrder = {
      id: "w",
      woNumber: 101951,
      market: "US",
      customerName: "Ryder",
      poNumber: null,
      unitNumber: null,
      taxParts: false,
      taxLabor: false,
      taxShipping: false,
      customerTaxExempt: false,
    };
    const r = buildInvoicePayload(
      wo,
      [{ catalogItemId: "c1", sku: "SVC", name: "DPF Cleaning", qty: 1, customerUnitPrice: 300, taxClass: "labor" }],
      { qboCustomerId: RYDER_ID, qboDisplayName: "Ryder Fleet Services" },
      { customer: { c1: { qboItemId: "11", qboItemName: "EVACUFLUSH AND BAKE DPF - RYDER", invoiceDescription: evacu } }, default: {} },
      {},
      { label: "297", addressLine1: "1 Site Rd", city: "Colorado Springs", region: "CO", postalCode: "80901", country: "US" },
    );
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[0].Description).toBe(evacu);
  });

  it("puts each measurement reading on its own line", () => {
    const dpf: InvoiceComponent = {
      seq: 1,
      componentType: "DPF",
      manufacturer: "Cummins",
      partNumber: "A029Y916",
      serialNumber: null,
      dpBefore: 12.5,
      dpAfter: 1.25,
      weightBeforeG: null,
      weightAfterG: null,
      weightRemovedG: null,
      result: "cleaned",
    };
    expect(measurementDescription(dpf)).toBe(
      "Manufacturer: Cummins\nPart Number: A029Y916\nPressure before: 12.5\nPressure after: 1.25\nResult: Cleaned Successfully",
    );
  });
});

describe("sync note", () => {
  it("keeps the invoice number readable when notes follow it", () => {
    const note = createdNote("1043", ["Billed to Ryder Fleet Services:RYDER - 297-COLORADO SPRINGS CO."]);
    expect(note).toMatch(/297-COLORADO SPRINGS/);
    expect(pendingQbInvoice([{ status: "ok", external_id: "145", error: note, at: "2026-11-11T10:00:00Z" }])).toEqual({
      id: "145",
      number: "1043",
      at: "2026-11-11T10:00:00Z",
    });
  });
});
