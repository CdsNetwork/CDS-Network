/**
 * One order across 2 shops (CDS, 2026-11-17, milestone M4): two linked work orders get ONE
 * customer invoice in QuickBooks with the lines of both; each shop still gets its own bill.
 *
 * The pure part (@/lib/qbo/invoice-combined): which work orders the invoice covers, the
 * header from the first work order (lowest WO number), the lines of both, both WO numbers in
 * the internal note, and the refusals (other customer, PO, location or unit; a work order
 * that is cancelled, invoiced or has its own invoice; more than two linked work orders).
 */
import { describe, expect, it } from "vitest";
import type {
  CustomerMapping,
  InvoiceComponent,
  InvoiceLine,
  InvoiceLocation,
  InvoiceWorkOrder,
  ItemMappings,
  MeasurementMappings,
} from "@/lib/qbo/invoice";
import {
  buildCombinedInvoicePayload,
  combinedPrivateNote,
  combinedTaxView,
  invoiceGroup,
  linkedReadiness,
  type InvoicePart,
} from "@/lib/qbo/invoice-combined";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DPF = "11111111-1111-4111-8111-111111111111";
const REMAN = "22222222-2222-4222-8222-222222222222";
const SHIP = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "44444444-4444-4444-8444-444444444444";
const LOCATION = "55555555-5555-4555-8555-555555555555";

const location: InvoiceLocation = {
  label: "RYD-1 Ryder Dallas",
  addressLine1: "1200 Example Rd",
  city: "Dallas",
  region: "TX",
  postalCode: "75201",
  country: "US",
};
const customerMap: CustomerMapping = { qboCustomerId: "58", qboDisplayName: "Ryder Fleet Services" };
const itemMap: ItemMappings = {
  customer: {},
  default: {
    [DPF]: { qboItemId: "1", qboItemName: "DPF Cleaning", invoiceDescription: "DPF clean and bake" },
    [REMAN]: { qboItemId: "2", qboItemName: "Reman DPF", invoiceDescription: "Remanufactured DPF" },
    [SHIP]: { qboItemId: "3", qboItemName: "Shipping" },
  },
};
const measurementMap: MeasurementMappings = { customer: {}, default: { DPF: { qboItemId: "90", qboItemName: "DPF measurements" } } };

const wo = (over: Partial<InvoiceWorkOrder>): InvoiceWorkOrder => ({
  id: A,
  woNumber: 104101,
  market: "US",
  customerName: "Ryder",
  poNumber: "0899253330",
  unitNumber: "T-77",
  taxParts: true,
  taxLabor: false,
  taxShipping: false,
  customerTaxExempt: false,
  ...over,
});

const component = (seq: number): InvoiceComponent => ({
  seq,
  componentType: "DPF",
  manufacturer: "Cummins",
  partNumber: "A123",
  serialNumber: `SN${seq}`,
  dpBefore: null,
  dpAfter: null,
  weightBeforeG: null,
  weightAfterG: null,
  weightRemovedG: null,
  result: "condemned",
});

const part = (over: Partial<InvoicePart> & { workOrder: InvoiceWorkOrder }): InvoicePart => ({
  status: "in_process",
  qbInvoiceId: null,
  customerId: CUSTOMER,
  locationId: LOCATION,
  lines: [],
  customerMap,
  itemMap,
  aliases: {},
  location,
  components: [],
  measurementMap,
  refs: {},
  ...over,
});

const line = (catalogItemId: string, sku: string, price: number, taxClass: InvoiceLine["taxClass"], qty = 1): InvoiceLine => ({
  catalogItemId,
  sku,
  name: sku,
  qty,
  customerUnitPrice: price,
  taxClass,
});

// The local shop cleaned the filters (and condemned them); the second shop shipped remans.
const local = () =>
  part({
    workOrder: wo({ id: A, woNumber: 104101 }),
    status: "completed",
    lines: [line(DPF, "SVC-DPF", 325, "labor")],
    components: [component(1)],
    refs: { departmentId: "D1", classId: "CLS-LOCAL" },
  });
const second = () =>
  part({
    workOrder: wo({ id: B, woNumber: 104102, taxLabor: true }),
    status: "in_process",
    lines: [line(REMAN, "REMAN-DPF", 1450, "parts"), line(SHIP, "SHIP", 80, "shipping")],
    refs: { departmentId: "D1", classId: "CLS-SECOND" },
  });

const ok = (r: ReturnType<typeof buildCombinedInvoicePayload>) => {
  if (!r.ok) throw new Error(`expected an invoice: ${r.problems.join(" ")}`);
  return r;
};
const problems = (r: ReturnType<typeof buildCombinedInvoicePayload>) => (r.ok ? [] : r.problems);

describe("invoiceGroup: which work orders one invoice covers", () => {
  it("is this order alone without a link", () => {
    expect(invoiceGroup(A, [])).toEqual({ kind: "solo" });
    expect(invoiceGroup(A, [{ work_order_id: B, linked_work_order_id: C }])).toEqual({ kind: "solo" });
  });

  it("is the pair, whichever side set the link, also when both sides did", () => {
    expect(invoiceGroup(A, [{ work_order_id: A, linked_work_order_id: B }])).toEqual({ kind: "pair", linkedId: B });
    expect(invoiceGroup(A, [{ work_order_id: B, linked_work_order_id: A }])).toEqual({ kind: "pair", linkedId: B });
    expect(
      invoiceGroup(A, [
        { work_order_id: A, linked_work_order_id: B },
        { work_order_id: B, linked_work_order_id: A },
      ]),
    ).toEqual({ kind: "pair", linkedId: B });
  });

  it("is refused for more than two linked work orders, also through the other order", () => {
    expect(
      invoiceGroup(A, [
        { work_order_id: A, linked_work_order_id: B },
        { work_order_id: C, linked_work_order_id: A },
      ]),
    ).toEqual({ kind: "too_many", ids: [A, B, C].sort() });
    expect(
      invoiceGroup(A, [
        { work_order_id: A, linked_work_order_id: B },
        { work_order_id: C, linked_work_order_id: B },
      ]),
    ).toEqual({ kind: "too_many", ids: [A, B, C].sort() });
  });
});

describe("buildCombinedInvoicePayload: one invoice with the lines of both work orders", () => {
  it("has the lines of both, first work order first, whichever page it is created from", () => {
    for (const parts of [[local(), second()], [second(), local()]] as [InvoicePart, InvoicePart][]) {
      const r = ok(buildCombinedInvoicePayload(parts));
      expect(r.payload.Line.map((l) => [l.Description, l.Amount])).toEqual([
        ["DPF clean and bake", 325],
        ["Manufacturer: Cummins\nPart Number: A123\nSerial Number: SN1\nResult: Condemned", 0],
        ["Remanufactured DPF", 1450],
        // No invoice text: our item name until QuickBooks' own text is filled in when sending.
        ["SHIP", 80],
      ]);
    }
  });

  it("taxes each line by the tax settings of its own work order", () => {
    const r = ok(buildCombinedInvoicePayload([local(), second()]));
    // 104101 does not tax labor; 104102 taxes parts but not shipping.
    expect(r.payload.Line.map((l) => l.SalesItemLineDetail.TaxCodeRef.value)).toEqual(["NON", "NON", "TAX", "NON"]);
  });

  it("takes the header from the first work order: customer, ship-to, Division, Class, PO and unit", () => {
    const r = ok(buildCombinedInvoicePayload([second(), local()]));
    expect(r.payload.CustomerRef).toEqual({ value: "58", name: "Ryder Fleet Services" });
    expect(r.payload.ShipAddr).toMatchObject({ Line1: "1200 Example Rd", City: "Dallas", CountrySubDivisionCode: "TX" });
    expect(r.payload.DepartmentRef).toEqual({ value: "D1" });
    expect(r.payload.ClassRef).toEqual({ value: "CLS-LOCAL" });
    expect(r.payload.CustomerMemo).toEqual({ value: "PO 0899253330 | Unit T-77" });
    expect(r.primaryId).toBe(A);
    expect(r.unitNumber).toBe("T-77");
  });

  it("names both WO numbers in the internal note", () => {
    const r = ok(buildCombinedInvoicePayload([second(), local()]));
    expect(r.payload.PrivateNote).toBe("Portal WO-104101 + WO-104102 | PO 0899253330");
    expect(combinedPrivateNote([104102, 104101], null)).toBe("Portal WO-104101 + WO-104102");
  });

  it("keeps the QuickBooks item text positions of the second work order's lines", () => {
    const r = ok(buildCombinedInvoicePayload([local(), second()]));
    // Shipping has no invoice description: its QuickBooks text is looked up when sending.
    expect(r.itemText).toEqual([{ index: 3, qboItemId: "3", line: { name: "SHIP", description: undefined }, alias: undefined }]);
  });

  it("uses the unit of the other work order when the first has none", () => {
    const a = local();
    a.workOrder = { ...a.workOrder, unitNumber: null };
    const r = ok(buildCombinedInvoicePayload([a, second()]));
    expect(r.unitNumber).toBe("T-77");
    expect(r.payload.CustomerMemo).toEqual({ value: "PO 0899253330 | Unit T-77" });
  });
});

describe("refusals", () => {
  it("another customer", () => {
    const b = second();
    b.customerId = "66666666-6666-4666-8666-666666666666";
    b.workOrder = { ...b.workOrder, customerName: "Penske" };
    expect(problems(buildCombinedInvoicePayload([local(), b]))).toContain(
      "WO-104101 is for Ryder and WO-104102 is for Penske. One invoice is for one customer: correct the customer or remove the link.",
    );
  });

  it("another PO, or a PO on one only", () => {
    const b = second();
    b.workOrder = { ...b.workOrder, poNumber: "0899253331" };
    expect(problems(buildCombinedInvoicePayload([local(), b]))).toContain(
      "WO-104101 has PO 0899253330 and WO-104102 has PO 0899253331. One invoice has one PO: correct the PO or remove the link.",
    );
    b.workOrder = { ...b.workOrder, poNumber: " " };
    expect(problems(buildCombinedInvoicePayload([local(), b]))).toContain(
      "WO-104101 has PO 0899253330 and WO-104102 has no PO. One invoice has one PO: correct the PO or remove the link.",
    );
  });

  it("the same PO written in other case or with spaces is the same PO", () => {
    const a = local();
    a.workOrder = { ...a.workOrder, poNumber: "po-77a" };
    const b = second();
    b.workOrder = { ...b.workOrder, poNumber: " PO-77A " };
    expect(buildCombinedInvoicePayload([a, b]).ok).toBe(true);
  });

  it("another location", () => {
    const b = second();
    b.locationId = "77777777-7777-4777-8777-777777777777";
    b.location = { ...location, label: "RYD-2 Ryder Fort Worth" };
    expect(problems(buildCombinedInvoicePayload([local(), b]))).toContain(
      "WO-104101 is for location RYD-1 Ryder Dallas and WO-104102 for RYD-2 Ryder Fort Worth. One invoice has one ship-to address: correct the location or remove the link.",
    );
  });

  it("two different units", () => {
    const b = second();
    b.workOrder = { ...b.workOrder, unitNumber: "T-78" };
    expect(problems(buildCombinedInvoicePayload([local(), b]))).toContain(
      "WO-104101 is for unit T-77 and WO-104102 for unit T-78. One invoice has one Fleet Number: correct the unit or remove the link.",
    );
  });

  it("says which work order is not ready: cancelled, invoiced, or invoiced on its own", () => {
    const b = second();
    b.status = "cancelled";
    expect(problems(buildCombinedInvoicePayload([local(), b]))).toContain(
      "WO-104102 is cancelled. Remove the link to invoice WO-104101 on its own.",
    );
    b.status = "completed";
    b.qbInvoiceId = "145";
    expect(problems(buildCombinedInvoicePayload([local(), b]))).toContain(
      "WO-104102 already has its own QuickBooks invoice 145. Remove the link to invoice WO-104101 on its own.",
    );
    expect(linkedReadiness({ woNumber: 104102, status: "invoiced", qbInvoiceId: null }, 104101)).toBe(
      "WO-104102 is already invoiced. Remove the link to invoice WO-104101 on its own.",
    );
    expect(linkedReadiness({ woNumber: 104102, status: "in_process", qbInvoiceId: null }, 104101)).toBeNull();
  });

  it("names the work order with the problem, and a problem both have once", () => {
    const b = second();
    b.lines = [{ ...line(REMAN, "REMAN-DPF", 0, "parts"), customerUnitPrice: null }];
    const noCustomer = { customerMap: null };
    const r = buildCombinedInvoicePayload([{ ...local(), ...noCustomer }, { ...b, ...noCustomer }]);
    const p = problems(r);
    expect(p).toContain("WO-104101 and WO-104102: Ryder is not linked to a QuickBooks customer. Link it on Admin > QuickBooks mappings.");
    expect(p.filter((x) => x.includes("not linked to a QuickBooks customer"))).toHaveLength(1);
    expect(p.some((x) => x.startsWith("WO-104102: ") && /price/i.test(x))).toBe(true);
  });

  it("is not built when the first work order is fine but the second has no lines", () => {
    const b = second();
    b.lines = [];
    expect(problems(buildCombinedInvoicePayload([local(), b]))).toContain("WO-104102: The work order has no lines to invoice.");
  });
});

describe("combinedTaxView: the tax box of a work order on the combined invoice", () => {
  const view = { taxLabel: "Sales tax (QuickBooks)", tax: 125, totalLabel: "Customer invoice total", total: 1900, note: "From QuickBooks invoice 1043." };
  it("says the QuickBooks tax and total are for both work orders", () => {
    expect(combinedTaxView(view, true, [104102, 104101])).toEqual({
      ...view,
      taxLabel: "Sales tax (QuickBooks), WO-104101 + WO-104102",
      totalLabel: "Combined invoice total (WO-104101 + WO-104102)",
      note: "From QuickBooks invoice 1043. One QuickBooks invoice covers WO-104101 + WO-104102: its tax and total are for both work orders.",
    });
  });
  it("is unchanged before the invoice is recorded, and for a work order on its own", () => {
    expect(combinedTaxView(view, false, [104101, 104102])).toBe(view);
    expect(combinedTaxView(view, true, null)).toBe(view);
  });
});
