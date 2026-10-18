import { describe, expect, it } from "vitest";
import {
  buildInvoicePayload,
  cents,
  type CustomerAlias,
  type CustomerMapping,
  type InvoiceLine,
  type InvoiceLocation,
  type InvoiceComponent,
  type InvoiceWorkOrder,
  type ItemMapping,
  type ItemMappings,
  type MeasurementMappings,
  measurementDescription,
} from "@/lib/qbo/invoice";
import { faultMessage, QboError } from "@/lib/qbo/client";
import { passThroughInput } from "@/lib/pass-through";
import { qboConfig } from "@/lib/qbo/config";
import { createState, decryptToken, encryptToken, verifyState } from "@/lib/qbo/secure";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const PART = "22222222-2222-4222-8222-222222222222";
const FREIGHT = "33333333-3333-4333-8333-333333333333";
const EXEMPT = "44444444-4444-4444-8444-444444444444";

const wo = (over: Partial<InvoiceWorkOrder> = {}): InvoiceWorkOrder => ({
  id: "99999999-9999-4999-8999-999999999999",
  woNumber: 100123,
  market: "US",
  customerName: "First Student",
  poNumber: "PO-778",
  unitNumber: "BUS 42",
  taxParts: true,
  taxLabor: false,
  taxShipping: true,
  customerTaxExempt: false,
  ...over,
});

const lines: InvoiceLine[] = [
  { catalogItemId: SERVICE, sku: "SVC-DPF", name: "DPF cleaning", qty: 1, customerUnitPrice: 325, taxClass: "labor" },
  { catalogItemId: PART, sku: "GSK-1", name: "Gasket", qty: 2, customerUnitPrice: 12.5, taxClass: "parts" },
  { catalogItemId: FREIGHT, sku: "SHIP", name: "Freight", qty: 1, customerUnitPrice: 40, taxClass: "shipping" },
  { catalogItemId: EXEMPT, sku: "FEE", name: "Core fee", qty: 1, customerUnitPrice: 10, taxClass: "exempt" },
];

const customer: CustomerMapping = { qboCustomerId: "58", qboDisplayName: "First Student Inc" };
const items: Record<string, ItemMapping> = {
  [SERVICE]: { qboItemId: "1", qboItemName: "DPF Cleaning" },
  [PART]: { qboItemId: "2", qboItemName: "Gasket" },
  [FREIGHT]: { qboItemId: "3", qboItemName: "Shipping" },
  [EXEMPT]: { qboItemId: "4", qboItemName: "Core Fee" },
};
const location: InvoiceLocation = {
  label: "FS-DAL Dallas yard",
  addressLine1: "1200 Example Rd",
  city: "Dallas",
  region: "tx",
  postalCode: "75201",
  country: "US",
};

function build(over: Partial<{
  wo: InvoiceWorkOrder;
  lines: InvoiceLine[];
  customer: CustomerMapping | null;
  /** Default (all customers) item rows. */
  items: Record<string, ItemMapping | undefined>;
  /** Item rows for this work order's customer. */
  customerItems: Record<string, ItemMapping | undefined>;
  /** Items linked for other customers only. */
  otherCustomers: Record<string, boolean>;
  aliases: Record<string, CustomerAlias>;
  location: InvoiceLocation | null;
  components: InvoiceComponent[];
  measurements: MeasurementMappings;
}> = {}) {
  const itemMap: ItemMappings = {
    customer: over.customerItems ?? {},
    default: over.items ?? items,
    otherCustomers: over.otherCustomers ?? {},
  };
  return buildInvoicePayload(
    over.wo ?? wo(),
    over.lines ?? lines,
    over.customer === undefined ? customer : over.customer,
    itemMap,
    over.aliases ?? {},
    over.location === undefined ? location : over.location,
    over.components ?? [],
    over.measurements ?? { customer: {}, default: {} },
  );
}

describe("buildInvoicePayload", () => {
  it("builds the invoice: customer, ship-to, lines at the customer price, no tax detail", () => {
    const r = build();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload;
    expect(p.CustomerRef).toEqual({ value: "58", name: "First Student Inc" });
    expect(p.ShipAddr).toEqual({
      Line1: "1200 Example Rd",
      City: "Dallas",
      CountrySubDivisionCode: "TX",
      PostalCode: "75201",
      Country: "US",
    });
    expect(p.Line).toHaveLength(4);
    expect(p.Line[1]).toEqual({
      DetailType: "SalesItemLineDetail",
      Amount: 25,
      Description: "Gasket",
      SalesItemLineDetail: { ItemRef: { value: "2", name: "Gasket" }, Qty: 2, UnitPrice: 12.5, TaxCodeRef: { value: "TAX" } },
    });
    expect(p).not.toHaveProperty("TxnTaxDetail");
    expect(p).not.toHaveProperty("DocNumber");
    expect(p.PrivateNote).toBe("Portal WO-100123 | PO PO-778");
  });

  it("marks lines taxable from the work order's tax flags; exempt lines are never taxable", () => {
    const r = build();
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line.map((l) => l.SalesItemLineDetail.TaxCodeRef.value)).toEqual(["NON", "TAX", "TAX", "NON"]);

    const flipped = build({ wo: wo({ taxParts: false, taxLabor: true, taxShipping: false }) });
    if (!flipped.ok) throw new Error(flipped.problems.join("; "));
    expect(flipped.payload.Line.map((l) => l.SalesItemLineDetail.TaxCodeRef.value)).toEqual(["TAX", "NON", "NON", "NON"]);
  });

  it("a tax exempt customer gets every line non-taxable", () => {
    const r = build({ wo: wo({ customerTaxExempt: true }) });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line.every((l) => l.SalesItemLineDetail.TaxCodeRef.value === "NON")).toBe(true);
  });

  it("shows the customer's own part number in the description when there is one", () => {
    const r = build({ aliases: { [PART]: { partNumber: "FS-99812" } } });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[1].Description).toBe("Part # FS-99812 - Gasket");
    expect(r.payload.Line[0].Description).toBe("DPF cleaning");
  });

  it("uses the customer's own description with its part number when there is one", () => {
    const r = build({
      aliases: {
        [PART]: { partNumber: " 2871451 ", description: " GASKET, FILTER, PARTICULATE " },
        [SERVICE]: { partNumber: "CDS-DPF-CLEAN", description: null },
      },
    });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[1].Description).toBe("Part # 2871451 - GASKET, FILTER, PARTICULATE");
    expect(r.payload.Line[0].Description).toBe("Part # CDS-DPF-CLEAN - DPF cleaning");
    // Lines without an alias keep our name; the QuickBooks item and price do not change.
    expect(r.payload.Line[2].Description).toBe("Freight");
    expect(r.payload.Line[1].SalesItemLineDetail.ItemRef).toEqual({ value: "2", name: "Gasket" });
    expect(r.payload.Line[1].Amount).toBe(25);
  });

  it("ignores a blank customer part number", () => {
    const r = build({ aliases: { [PART]: { partNumber: "  ", description: "SHOULD NOT SHOW" } } });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[1].Description).toBe("Gasket");
  });

  it("lists every unmapped item once and the missing customer link instead of a payload", () => {
    const twice = [...lines, { ...lines[1], qty: 1 }];
    const r = build({ lines: twice, customer: null, items: { [SERVICE]: items[SERVICE], [FREIGHT]: items[FREIGHT], [EXEMPT]: items[EXEMPT] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      "First Student is not linked to a QuickBooks customer. Link it on Admin > QuickBooks mappings.",
      "GSK-1 Gasket is not linked to a QuickBooks item. Link it on Admin > QuickBooks mappings.",
    ]);
  });

  it("needs a 5-digit ZIP, a street, a city and a state on the ship-to location", () => {
    const noZip = build({ location: { ...location, postalCode: "752" } });
    expect(noZip.ok).toBe(false);
    if (!noZip.ok) expect(noZip.problems).toEqual(["Location FS-DAL Dallas yard needs a 5-digit ZIP code (Admin > Locations)."]);

    const blank = build({ location: { ...location, addressLine1: " ", city: null, region: "Texas", postalCode: null } });
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.problems).toEqual([
        "Location FS-DAL Dallas yard needs its street, city, 2-letter state filled in (Admin > Locations).",
        "Location FS-DAL Dallas yard needs a 5-digit ZIP code (Admin > Locations).",
      ]);
    }

    const zip4 = build({ location: { ...location, postalCode: "75201-1234" } });
    expect(zip4.ok).toBe(true);
  });

  it("needs a location at all, a US order and at least one line", () => {
    const r = build({ location: null, lines: [], wo: wo({ market: "CA" }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      "QuickBooks invoices are set up for US work orders only.",
      "The work order has no customer location, so there is no ship-to address for sales tax.",
      "The work order has no lines to invoice.",
    ]);
  });

  it("reports a line without a customer price", () => {
    const r = build({ lines: [{ ...lines[0], customerUnitPrice: null }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(["SVC-DPF has no customer price."]);
  });

  it("puts the PO in the internal note and the customer memo, and leaves both out when there is no PO", () => {
    const r = build();
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.CustomerMemo).toEqual({ value: "PO PO-778 | Unit BUS 42" });

    const noPo = build({ wo: wo({ poNumber: null, unitNumber: null }) });
    if (!noPo.ok) throw new Error(noPo.problems.join("; "));
    expect(noPo.payload.PrivateNote).toBe("Portal WO-100123");
    expect(noPo.payload).not.toHaveProperty("CustomerMemo");
  });

  it("rounds line amounts to cents", () => {
    expect(cents(1.005)).toBe(1.01);
    const r = build({ lines: [{ ...lines[1], qty: 3, customerUnitPrice: 0.335 }] });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[0].Amount).toBe(1.01);
  });
});

describe("customer-specific QuickBooks items", () => {
  const ryderService: ItemMapping = { qboItemId: "101", qboItemName: "EVACUFLUSH AND BAKE DPF - FIRST STUDENT" };

  it("uses the item mapped for this customer before the item mapped for all customers", () => {
    const r = build({ customerItems: { [SERVICE]: ryderService } });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[0].SalesItemLineDetail.ItemRef).toEqual({ value: "101", name: "EVACUFLUSH AND BAKE DPF - FIRST STUDENT" });
    // Items without a customer row fall back to the default row.
    expect(r.payload.Line[1].SalesItemLineDetail.ItemRef).toEqual({ value: "2", name: "Gasket" });
  });

  it("uses a customer row even when there is no default row", () => {
    const { [SERVICE]: _omit, ...noDefault } = items;
    void _omit;
    const r = build({ items: noDefault, customerItems: { [SERVICE]: ryderService } });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[0].SalesItemLineDetail.ItemRef.value).toBe("101");
  });

  it("names the customer when the item is linked for other customers only", () => {
    const { [SERVICE]: _omit, ...noDefault } = items;
    void _omit;
    const r = build({ items: noDefault, otherCustomers: { [SERVICE]: true } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      "SVC-DPF DPF cleaning is not linked to a QuickBooks item for First Student (it is linked for other customers only). Link it for First Student or for all customers on Admin > QuickBooks mappings.",
    ]);
  });
});

describe("measurement lines", () => {
  const dpf: InvoiceComponent = {
    seq: 1,
    componentType: "DPF",
    manufacturer: "Cummins",
    partNumber: "A029Y916",
    serialNumber: "SN-1",
    dpBefore: 12.5,
    dpAfter: 1.25,
    weightBeforeG: 15250.0,
    weightAfterG: 14800.5,
    weightRemovedG: 449.5,
    result: "cleaned",
  };
  const doc: InvoiceComponent = {
    ...dpf,
    seq: 2,
    componentType: "DOC",
    manufacturer: "Detroit",
    partNumber: null,
    serialNumber: "SN-2",
    dpBefore: null,
    dpAfter: null,
    weightBeforeG: null,
    weightAfterG: null,
    weightRemovedG: null,
  };
  const egr: InvoiceComponent = {
    seq: 3,
    componentType: "EGR",
    manufacturer: "Volvo",
    partNumber: "EGR-9",
    serialNumber: "SN-3",
    dpBefore: null,
    dpAfter: null,
    weightBeforeG: null,
    weightAfterG: null,
    weightRemovedG: null,
    result: "failed",
  };
  const measurements: MeasurementMappings = {
    customer: { DPF: { qboItemId: "201", qboItemName: "DPF MEASUREMENTS & INFO - First Student" } },
    default: {
      DPF: { qboItemId: "300", qboItemName: "DPF MEASUREMENTS & INFO" },
      DOC: { qboItemId: "301", qboItemName: "DOC MEASUREMENTS & INFO" },
      EGR: { qboItemId: "303", qboItemName: "EGR MEASUREMENTS & INFO" },
    },
  };

  it("describes a DPF with every measurement and the result", () => {
    expect(measurementDescription(dpf)).toBe(
      "Manufacturer: Cummins / Part Number: A029Y916 / Serial Number: SN-1 / Pressure before: 12.5 / Pressure after: 1.25 / Weight before: 15250 g / Weight after: 14800.5 g / Weight removed: 449.5 g / Result: Cleaned Successfully",
    );
  });

  it("leaves out empty fields", () => {
    expect(measurementDescription({ ...doc, result: null })).toBe("Manufacturer: Detroit / Serial Number: SN-2");
  });

  it("describes an EGR with manufacturer, part, serial and Pass or Fail only", () => {
    expect(measurementDescription(egr)).toBe("Manufacturer: Volvo / Part Number: EGR-9 / Serial Number: SN-3 / Result: Fail");
    expect(measurementDescription({ ...egr, result: "passed", dpBefore: 5 })).toBe(
      "Manufacturer: Volvo / Part Number: EGR-9 / Serial Number: SN-3 / Result: Pass",
    );
  });

  it("keeps the description within the QuickBooks limit of 4000 characters", () => {
    const long = { ...dpf, manufacturer: "M".repeat(5000) };
    expect(measurementDescription(long).length).toBeLessThanOrEqual(4000);
  });

  it("adds one $0 non-taxable line per component after the billable lines, in seq order, customer item first", () => {
    const r = build({ components: [egr, doc, dpf], measurements });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.warnings).toEqual([]);
    expect(r.payload.Line).toHaveLength(lines.length + 3);
    const extra = r.payload.Line.slice(lines.length);
    expect(extra.map((l) => l.SalesItemLineDetail.ItemRef.value)).toEqual(["201", "301", "303"]);
    expect(extra[0]).toEqual({
      DetailType: "SalesItemLineDetail",
      Amount: 0,
      Description: measurementDescription(dpf),
      SalesItemLineDetail: {
        ItemRef: { value: "201", name: "DPF MEASUREMENTS & INFO - First Student" },
        Qty: 1,
        UnitPrice: 0,
        TaxCodeRef: { value: "NON" },
      },
    });
    for (const l of extra) {
      expect(l.Amount).toBe(0);
      expect(l.SalesItemLineDetail.UnitPrice).toBe(0);
      expect(l.SalesItemLineDetail.Qty).toBe(1);
      expect(l.SalesItemLineDetail.TaxCodeRef.value).toBe("NON");
    }
    expect(extra[2].Description).toBe("Manufacturer: Volvo / Part Number: EGR-9 / Serial Number: SN-3 / Result: Fail");
  });

  it("skips a component type without a measurement item and warns, without blocking the invoice", () => {
    const scr: InvoiceComponent = { ...doc, seq: 4, componentType: "SCR" };
    const r = build({ components: [dpf, scr, { ...scr, seq: 5 }], measurements });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.Line).toHaveLength(lines.length + 1);
    expect(r.warnings).toEqual([
      "No QuickBooks measurement item for SCR (First Student or all customers), so SCR #4, SCR #5 measurements are not on the invoice. Map one on Admin > QuickBooks mappings.",
    ]);
  });

  it("keeps warnings next to problems when the invoice cannot be built", () => {
    const r = build({ customer: null, components: [{ ...doc, componentType: "SCR" }], measurements });
    expect(r.ok).toBe(false);
    expect(r.warnings).toHaveLength(1);
  });

  it("adds no measurement lines when the work order has no components", () => {
    const r = build({ measurements });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line).toHaveLength(lines.length);
    expect(r.warnings).toEqual([]);
  });
});

describe("QuickBooks helpers", () => {
  it("reads the configuration only when every value is set and the environment is valid", () => {
    const env = { QBO_CLIENT_ID: "id", QBO_CLIENT_SECRET: "s", QBO_ENVIRONMENT: "sandbox", QBO_REDIRECT_URI: "https://x/cb" };
    expect(qboConfig(env)?.environment).toBe("sandbox");
    expect(qboConfig({ ...env, QBO_ENVIRONMENT: "prod" })).toBeNull();
    expect(qboConfig({ ...env, QBO_CLIENT_SECRET: "" })).toBeNull();
  });

  it("turns an Intuit fault into a readable message", () => {
    const body = {
      Fault: {
        type: "ValidationFault",
        Error: [{ Message: "Invalid Reference Id", Detail: "Invalid Reference Id : Item assigned to this transaction has been deleted", code: "2500" }],
      },
    };
    expect(faultMessage(body, "x")).toEqual({
      message: "Invalid Reference Id: Invalid Reference Id : Item assigned to this transaction has been deleted",
      type: "ValidationFault",
      code: "2500",
    });
    expect(faultMessage(null, "fallback").message).toBe("fallback");
  });

  it("treats a 400 as a refusal (nothing created) but not a timeout, 401 or 5xx", () => {
    expect(new QboError("x", 400).rejected).toBe(true);
    expect(new QboError("x", 401).rejected).toBe(false);
    expect(new QboError("x", 500).rejected).toBe(false);
    expect(new QboError("x", 0).rejected).toBe(false);
  });

  it("accepts the OAuth state only from the same login, unexpired and unchanged", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const { state, cookie } = createState("secret", "user-1", now);
    expect(verifyState("secret", cookie, state, "user-1", now + 1000)).toBe(true);
    expect(verifyState("secret", cookie, state, "user-2", now)).toBe(false);
    expect(verifyState("secret", cookie, "other", "user-1", now)).toBe(false);
    expect(verifyState("other-secret", cookie, state, "user-1", now)).toBe(false);
    expect(verifyState("secret", cookie, state, "user-1", now + 11 * 60 * 1000)).toBe(false);
    expect(verifyState("secret", undefined, state, "user-1", now)).toBe(false);
    const [s, p, exp, sig] = cookie.split(".");
    expect(verifyState("secret", [s, p, String(Number(exp) + 9999), sig].join("."), state, "user-1", now)).toBe(false);
  });

  it("encrypts tokens so the stored value is not the token, and decrypts them back", () => {
    const stored = encryptToken("secret", "access-token-value");
    expect(stored).not.toContain("access-token-value");
    expect(decryptToken("secret", stored)).toBe("access-token-value");
    expect(() => decryptToken("other", stored)).toThrow();
  });
});

describe("Misc. hardware (price entered per line)", () => {
  const MISC = "55555555-5555-4555-8555-555555555555";
  const miscItem: ItemMapping = { qboItemId: "386", qboItemName: "MISC PART" };
  const misc = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
    catalogItemId: MISC,
    sku: "CDS-MISC-HARDWARE",
    name: "Misc. hardware",
    description: "Bolts and nuts for DPF kit",
    qty: 1,
    customerUnitPrice: 7.43,
    taxClass: "parts",
    ...over,
  });

  it("bills the amount from the shop invoice as is, on the MISC PART item, with the line description", () => {
    const r = build({ lines: [lines[0], misc()], items: { ...items, [MISC]: miscItem } });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[1]).toEqual({
      DetailType: "SalesItemLineDetail",
      Amount: 7.43,
      Description: "Misc. hardware - Bolts and nuts for DPF kit",
      SalesItemLineDetail: { ItemRef: { value: "386", name: "MISC PART" }, Qty: 1, UnitPrice: 7.43, TaxCodeRef: { value: "TAX" } },
    });
  });

  it("is taxed as parts", () => {
    const r = build({ wo: wo({ taxParts: false, taxLabor: true }), lines: [misc()], items: { [MISC]: miscItem } });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[0].SalesItemLineDetail.TaxCodeRef.value).toBe("NON");
  });

  it("keeps each Misc. hardware line separate with its own description and amount", () => {
    const r = build({
      lines: [misc(), misc({ description: "Clamp bolts", customerUnitPrice: 3.1 })],
      items: { [MISC]: miscItem },
    });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line.map((l) => [l.Description, l.Amount])).toEqual([
      ["Misc. hardware - Bolts and nuts for DPF kit", 7.43],
      ["Misc. hardware - Clamp bolts", 3.1],
    ]);
  });

  it("needs a QuickBooks item like any other line", () => {
    const r = build({ lines: [misc(), misc({ description: "Second" })], items: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.filter((p) => p.includes("CDS-MISC-HARDWARE"))).toEqual([
      "CDS-MISC-HARDWARE Misc. hardware is not linked to a QuickBooks item. Link it on Admin > QuickBooks mappings.",
    ]);
  });

  it("puts a customer part number in front when the customer has one", () => {
    const r = build({ lines: [misc()], items: { [MISC]: miscItem }, aliases: { [MISC]: { partNumber: "FS-HW" } } });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.payload.Line[0].Description).toBe("Part # FS-HW - Misc. hardware - Bolts and nuts for DPF kit");
  });
});

describe("passThroughInput", () => {
  it("accepts a description and an amount in dollars and cents", () => {
    expect(passThroughInput(" Bolts for kit ", "7.43")).toEqual({ ok: true, description: "Bolts for kit", amount: 7.43 });
    expect(passThroughInput("Nuts", "$1,204.5")).toEqual({ ok: true, description: "Nuts", amount: 1204.5 });
  });

  it("refuses a missing or long description and a missing, zero, negative or fractional-cent amount", () => {
    expect(passThroughInput("", "5").ok).toBe(false);
    expect(passThroughInput("x".repeat(501), "5").ok).toBe(false);
    for (const amount of ["", "0", "-1", "abc", "1.234", "100000"]) {
      expect(passThroughInput("Bolts", amount).ok, amount).toBe(false);
    }
  });
});
