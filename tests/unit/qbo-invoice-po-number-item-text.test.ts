/**
 * Ashley's reports of 2026-11-12 on QuickBooks invoices:
 *  * the "PO Number" custom field was empty on the invoice while "Fleet Number" was filled.
 *    In CDS's company "PO Number" exists only as a custom field of the newer experience
 *    (DefinitionId 513140); QuickBooks keeps it only when the invoice is sent with
 *    include=enhancedAllCustomFields, and then Fleet Number must use its enhanced id too;
 *  * the DOC cleaning line said only "DOC Cleaning" where an invoice made by hand shows the
 *    QuickBooks item's own sales description.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createInvoice } from "@/lib/qbo/api";
import { buildInvoicePayload, type InvoiceWorkOrder, type QboInvoicePayload } from "@/lib/qbo/invoice";
import { resolveInvoiceQbo, type InvoiceTarget, type QboLookups } from "@/lib/qbo/invoice-qbo";

const RYDER_ID = "58";

/** CDS's Preferences: Fleet Number is the only classic field turned on. */
const cdsPrefs = {
  CustomField: [
    {
      CustomField: [
        { Name: "SalesFormsPrefs.UseSalesCustom1", Type: "BooleanType", BooleanValue: false },
        { Name: "SalesFormsPrefs.UseSalesCustom2", Type: "BooleanType", BooleanValue: false },
        { Name: "SalesFormsPrefs.UseSalesCustom3", Type: "BooleanType", BooleanValue: true },
      ],
    },
    {
      CustomField: [
        { Name: "SalesFormsPrefs.SalesCustomName1", Type: "StringType", StringValue: "P.O. Number (inactive)" },
        { Name: "SalesFormsPrefs.SalesCustomName2", Type: "StringType", StringValue: "Pick-Up Number" },
        { Name: "SalesFormsPrefs.SalesCustomName3", Type: "StringType", StringValue: "Fleet Number" },
      ],
    },
  ],
};

/** CDS's recent invoices read with include=enhancedAllCustomFields. */
const cdsRecentInvoices = [
  {
    CustomField: [
      { DefinitionId: "2800000000000120140", Name: "Fleet Number" },
      { DefinitionId: "513140", Name: "PO Number" },
    ],
  },
];

const DOC_TEXT =
  "Place DOC in EvacuBlast cabinet, test differential pressure for restriction, wash DOC, bake, retest differential pressure.";
const DPF_OVERRIDE = "Place Diesel Particulate Filter (DPF) in EvacuBlast cabinet (invoice text from the portal).";

const qboItems: Record<string, { Id: string; Name: string; Description?: string }> = {
  "21": { Id: "21", Name: "EVACUBLAST AND BAKE DOC - RYDER", Description: DOC_TEXT },
  "11": { Id: "11", Name: "EVACUFLUSH AND BAKE DPF - RYDER", Description: "QuickBooks DPF text" },
  "31": { Id: "31", Name: "FREIGHT", Description: "   " },
  "90": { Id: "90", Name: "DOC MEASUREMENTS", Description: "Measurement item text" },
};

function lookups(over: Partial<QboLookups> = {}): QboLookups {
  return {
    getCustomer: vi.fn(async () => ({ Id: RYDER_ID, DisplayName: "Ryder Fleet Services" })),
    listSubCustomers: vi.fn(async () => []),
    salesFormsPrefs: vi.fn(async () => cdsPrefs),
    recentInvoiceCustomFields: vi.fn(async () => cdsRecentInvoices),
    getItems: vi.fn(async (ids: string[]) => ids.map((id) => qboItems[id]).filter(Boolean)),
    ...over,
  };
}

const target = (over: Partial<InvoiceTarget> = {}): InvoiceTarget => ({
  locationId: null,
  siteNumber: null,
  locationName: null,
  city: null,
  poNumber: "4500123",
  unitNumber: "TRK 77",
  ...over,
});

const basePayload = (): QboInvoicePayload => ({
  CustomerRef: { value: RYDER_ID, name: "Ryder Fleet Services" },
  ShipAddr: { Line1: "1 Site Rd", City: "Colorado Springs", CountrySubDivisionCode: "CO", PostalCode: "80901", Country: "US" },
  Line: [],
  PrivateNote: "Portal WO-101951",
});

describe("PO Number custom field (enhanced custom fields)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates the invoice with include=enhancedAllCustomFields, keeping minorversion and requestid", async () => {
    const fetchMock = vi.fn<(url: URL | string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ Invoice: { Id: "145", DocNumber: "1043" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const created = await createInvoice({ environment: "production", realmId: "9130", accessToken: "t" }, basePayload(), "wo-1");
    expect(created.Id).toBe("145");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(url.pathname).toBe("/v3/company/9130/invoice");
    expect(url.searchParams.get("include")).toBe("enhancedAllCustomFields");
    expect(url.searchParams.get("minorversion")).toBe("75");
    expect(url.searchParams.get("requestid")).toBe("wo-1");
  });

  it("sends the enhanced ids learned from recent invoices for both Fleet Number and PO Number", async () => {
    const r = await resolveInvoiceQbo(lookups(), basePayload(), target(), null);
    expect(r.payload.CustomField).toEqual([
      { DefinitionId: "2800000000000120140", Name: "Fleet Number", Type: "StringType", StringValue: "TRK 77" },
      { DefinitionId: "513140", Name: "PO Number", Type: "StringType", StringValue: "4500123" },
    ]);
    expect(r.notes).toEqual([]);
  });

  it("does not cut an enhanced field to the classic 31 characters", async () => {
    const long = "P".repeat(40);
    const r = await resolveInvoiceQbo(lookups(), basePayload(), target({ poNumber: long }), null);
    expect(r.payload.CustomField?.find((f) => f.Name === "PO Number")?.StringValue).toBe(long);
  });

  it("falls back to the classic field when recent invoices cannot be read", async () => {
    const r = await resolveInvoiceQbo(
      lookups({
        recentInvoiceCustomFields: vi.fn(async () => {
          throw new Error("timeout");
        }),
      }),
      basePayload(),
      target(),
      null,
    );
    expect(r.payload.CustomField).toEqual([{ DefinitionId: "3", Name: "Fleet Number", Type: "StringType", StringValue: "TRK 77" }]);
    expect(r.notes).toEqual([expect.stringMatching(/no invoice custom field named "PO Number"/)]);
  });
});

describe("line description from the QuickBooks item", () => {
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

  function built() {
    const r = buildInvoicePayload(
      wo,
      [
        { catalogItemId: "doc", sku: "SVC-DOC", name: "DOC Cleaning", qty: 1, customerUnitPrice: 200, taxClass: "labor" },
        { catalogItemId: "dpf", sku: "SVC-DPF", name: "DPF Cleaning", qty: 1, customerUnitPrice: 300, taxClass: "labor" },
        { catalogItemId: "frt", sku: "FRT", name: "Freight", description: "UPS", qty: 1, customerUnitPrice: 40, taxClass: "shipping" },
      ],
      { qboCustomerId: RYDER_ID, qboDisplayName: "Ryder Fleet Services" },
      {
        customer: {
          doc: { qboItemId: "21", qboItemName: "EVACUBLAST AND BAKE DOC - RYDER", invoiceDescription: null },
          dpf: { qboItemId: "11", qboItemName: "EVACUFLUSH AND BAKE DPF - RYDER", invoiceDescription: DPF_OVERRIDE },
          frt: { qboItemId: "31", qboItemName: "FREIGHT" },
        },
        default: {},
      },
      {},
      { label: "297", addressLine1: "1 Site Rd", city: "Colorado Springs", region: "CO", postalCode: "80901", country: "US" },
      [
        {
          seq: 1,
          componentType: "DOC",
          manufacturer: "Cummins",
          partNumber: "A1",
          serialNumber: null,
          dpBefore: null,
          dpAfter: null,
          weightBeforeG: null,
          weightAfterG: null,
          weightRemovedG: null,
          result: "cleaned",
        },
      ],
      { customer: { DOC: { qboItemId: "90", qboItemName: "DOC MEASUREMENTS" } }, default: {} },
    );
    if (!r.ok) throw new Error(r.problems.join("; "));
    return r;
  }

  it("uses the QuickBooks item's sales description when there is no customer text or portal override", async () => {
    const b = built();
    const l = lookups();
    const r = await resolveInvoiceQbo(l, b.payload, target({ poNumber: null, unitNumber: null }), null, b.itemText);
    const lines = r.payload.Line.map((x) => x.Description);
    expect(lines[0]).toBe(DOC_TEXT);
    // The portal override still wins over QuickBooks.
    expect(lines[1]).toBe(DPF_OVERRIDE);
    // A blank QuickBooks description keeps our name; the text entered on the line stays.
    expect(lines[2]).toBe("Freight - UPS");
    // Measurement lines keep their readings.
    expect(lines[3]).toBe("Manufacturer: Cummins\nPart Number: A1\nResult: Cleaned Successfully");
    expect(l.getItems).toHaveBeenCalledTimes(1);
    expect(l.getItems).toHaveBeenCalledWith(["21", "31"]);
    expect(r.notes).toEqual([]);
  });

  it("keeps our item name, with a note, when QuickBooks items cannot be read", async () => {
    const b = built();
    const r = await resolveInvoiceQbo(
      lookups({
        getItems: vi.fn(async () => {
          throw new Error("timeout");
        }),
      }),
      b.payload,
      target({ poNumber: null, unitNumber: null }),
      null,
      b.itemText,
    );
    expect(r.payload.Line[0].Description).toBe("DOC Cleaning");
    expect(r.payload.Line[1].Description).toBe(DPF_OVERRIDE);
    expect(r.notes).toEqual([expect.stringMatching(/item descriptions could not be read \(timeout\)/)]);
  });
});
