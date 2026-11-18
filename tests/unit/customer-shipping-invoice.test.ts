/**
 * Automatic shipping charge on the customer's QuickBooks invoice (CDS, 2026-11-18).
 *
 * The amount (public.work_order_customer_shipping, 20261119120000_customer_shipping_charge.sql)
 * goes in the invoice's own Shipping box: a SalesItemLineDetail line whose ItemRef is
 * "SHIPPING_ITEM_ID", taxed by the order's "Tax shipping" setting. No line when the amount is
 * 0. Two linked work orders on one invoice: one Shipping box with the sum of both. A company
 * without shipping on its sales forms gets a clear message, not a raw QuickBooks error.
 */
import { describe, expect, it } from "vitest";
import {
  buildInvoicePayload,
  type CustomerMapping,
  type InvoiceLine,
  type InvoiceLocation,
  type InvoiceWorkOrder,
  type ItemMappings,
  type QboInvoicePayload,
} from "@/lib/qbo/invoice";
import { buildCombinedInvoicePayload, type InvoicePart } from "@/lib/qbo/invoice-combined";
import { resolveInvoiceQbo, type QboLookups } from "@/lib/qbo/invoice-qbo";
import {
  GESI_SHIPPING_ITEM_NAME,
  GesiShippingItemError,
  SHIPPING_ITEM_ID,
  ShippingNotAllowedError,
  shippingAmountOf,
  shippingRefusalMessage,
} from "@/lib/qbo/invoice-shipping";
import { parseShippingOverride, toCustomerShipping } from "@/lib/customer-shipping";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DPF = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "44444444-4444-4444-8444-444444444444";
const LOCATION = "55555555-5555-4555-8555-555555555555";

const location: InvoiceLocation = {
  label: "FLT-1 Fleet Dallas",
  addressLine1: "1200 Example Rd",
  city: "Dallas",
  region: "TX",
  postalCode: "75201",
  country: "US",
};
const customerMap: CustomerMapping = { qboCustomerId: "58", qboDisplayName: "Example Fleet" };
const itemMap: ItemMappings = { customer: {}, default: { [DPF]: { qboItemId: "1", qboItemName: "DPF Cleaning" } } };
const lines: InvoiceLine[] = [{ catalogItemId: DPF, sku: "SVC-DPF", name: "DPF cleaning", qty: 2, customerUnitPrice: 300, taxClass: "labor" }];

const wo = (over: Partial<InvoiceWorkOrder> = {}): InvoiceWorkOrder => ({
  id: A,
  woNumber: 104101,
  market: "US",
  customerName: "Example Fleet",
  poNumber: "PO-1",
  unitNumber: "T-1",
  taxParts: true,
  taxLabor: false,
  taxShipping: true,
  customerTaxExempt: false,
  ...over,
});

const build = (w: InvoiceWorkOrder) => buildInvoicePayload(w, lines, customerMap, itemMap, {}, location);
const payloadOf = (r: ReturnType<typeof build>): QboInvoicePayload => {
  if (!r.ok) throw new Error(r.problems.join(" "));
  return r.payload;
};
const shippingLines = (p: QboInvoicePayload) => p.Line.filter((l) => l.SalesItemLineDetail.ItemRef.value === SHIPPING_ITEM_ID);

describe("shipping box on one work order", () => {
  it("is a SHIPPING_ITEM_ID line after the other lines: a DPF and a DOC shipped = $56", () => {
    const p = payloadOf(build(wo({ shippingCharge: 56 })));
    expect(p.Line.at(-1)).toEqual({
      DetailType: "SalesItemLineDetail",
      Amount: 56,
      SalesItemLineDetail: { ItemRef: { value: "SHIPPING_ITEM_ID" }, TaxCodeRef: { value: "TAX" } },
    });
    expect(shippingLines(p)).toHaveLength(1);
    expect(shippingAmountOf(p)).toBe(56);
  });

  it("follows the order's Tax shipping setting and the customer's exemption", () => {
    expect(shippingLines(payloadOf(build(wo({ shippingCharge: 28, taxShipping: false }))))[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
    expect(
      shippingLines(payloadOf(build(wo({ shippingCharge: 28, taxShipping: true, customerTaxExempt: true }))))[0].SalesItemLineDetail.TaxCodeRef,
    ).toEqual({ value: "NON" });
  });

  it("is left off when the amount is 0 or not set", () => {
    expect(shippingLines(payloadOf(build(wo({ shippingCharge: 0 }))))).toEqual([]);
    expect(shippingLines(payloadOf(build(wo())))).toEqual([]);
    expect(shippingAmountOf(payloadOf(build(wo())))).toBe(0);
  });

  it("keeps cents", () => {
    expect(shippingAmountOf(payloadOf(build(wo({ shippingCharge: 45.5 }))))).toBe(45.5);
  });

  it("refuses a negative amount", () => {
    const r = build(wo({ shippingCharge: -5 }));
    expect(r.ok).toBe(false);
  });
});

const part = (w: InvoiceWorkOrder): InvoicePart => ({
  workOrder: w,
  status: "completed",
  qbInvoiceId: null,
  customerId: CUSTOMER,
  locationId: LOCATION,
  lines,
  customerMap,
  itemMap,
  aliases: {},
  location,
  components: [],
  measurementMap: { customer: {}, default: {} },
  refs: {},
});

describe("shipping box on a combined invoice", () => {
  it("carries the sum of both work orders in one line at the end", () => {
    const r = buildCombinedInvoicePayload([
      part(wo({ id: B, woNumber: 104102, shippingCharge: 34 })),
      part(wo({ id: A, woNumber: 104101, shippingCharge: 56 })),
    ]);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(shippingLines(r.payload)).toEqual([
      { DetailType: "SalesItemLineDetail", Amount: 90, SalesItemLineDetail: { ItemRef: { value: SHIPPING_ITEM_ID }, TaxCodeRef: { value: "TAX" } } },
    ]);
    expect(r.payload.Line.at(-1)!.SalesItemLineDetail.ItemRef.value).toBe(SHIPPING_ITEM_ID);
    expect(r.payload.Line).toHaveLength(3);
  });

  it("has no line when both are 0, and takes the tax setting of the order that has the charge", () => {
    const none = buildCombinedInvoicePayload([part(wo({ shippingCharge: 0 })), part(wo({ id: B, woNumber: 104102 }))]);
    if (!none.ok) throw new Error(none.problems.join(" "));
    expect(shippingLines(none.payload)).toEqual([]);

    const one = buildCombinedInvoicePayload([
      part(wo({ shippingCharge: 0, taxShipping: true })),
      part(wo({ id: B, woNumber: 104102, shippingCharge: 28, taxShipping: false })),
    ]);
    if (!one.ok) throw new Error(one.problems.join(" "));
    expect(shippingLines(one.payload)[0]).toMatchObject({ Amount: 28, SalesItemLineDetail: { TaxCodeRef: { value: "NON" } } });
  });

  it("asks CDS to align Tax shipping when both orders have a charge and tax it differently", () => {
    const r = buildCombinedInvoicePayload([
      part(wo({ shippingCharge: 28, taxShipping: true })),
      part(wo({ id: B, woNumber: 104102, shippingCharge: 28, taxShipping: false })),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join(" ")).toMatch(/Tax shipping/);
  });
});

const lookups = (prefs: { AllowShipping?: boolean } | null | Error): QboLookups => ({
  getCustomer: async () => null,
  listSubCustomers: async () => [],
  salesFormsPrefs: async () => {
    if (prefs instanceof Error) throw prefs;
    return prefs;
  },
  recentInvoiceCustomFields: async () => [],
  getItems: async () => [],
});
const target = { locationId: null, siteNumber: null, locationName: null, city: null, poNumber: null, unitNumber: null };

describe("a QuickBooks company without shipping on invoices", () => {
  it("stops before sending when SalesFormsPrefs.AllowShipping is false and the invoice has a shipping charge", async () => {
    const p = payloadOf(build(wo({ shippingCharge: 56 })));
    await expect(resolveInvoiceQbo(lookups({ AllowShipping: false }), p, target, null)).rejects.toBeInstanceOf(ShippingNotAllowedError);
    await expect(resolveInvoiceQbo(lookups({ AllowShipping: false }), p, target, null)).rejects.toThrow(/Shipping/);
  });

  it("sends when shipping is allowed, when the preference cannot be read, or when there is no shipping charge", async () => {
    const p = payloadOf(build(wo({ shippingCharge: 56 })));
    expect((await resolveInvoiceQbo(lookups({ AllowShipping: true }), p, target, null)).payload.Line).toHaveLength(2);
    expect((await resolveInvoiceQbo(lookups(new Error("timeout")), p, target, null)).payload.Line).toHaveLength(2);
    const none = payloadOf(build(wo()));
    expect((await resolveInvoiceQbo(lookups({ AllowShipping: false }), none, target, null)).payload.Line).toHaveLength(1);
  });

  it("turns a QuickBooks refusal about shipping into a clear message", () => {
    const p = payloadOf(build(wo({ shippingCharge: 56 })));
    const m = shippingRefusalMessage("Invalid Reference Id: Shipping is not enabled", p);
    expect(m).toMatch(/\$56\.00/);
    expect(m).toMatch(/Shipping/);
    expect(m).toMatch(/QuickBooks said: Invalid Reference Id: Shipping is not enabled/);
    expect(shippingRefusalMessage("Invalid Reference Id: SHIPPING_ITEM_ID", p)).not.toBeNull();
    expect(shippingRefusalMessage("Duplicate Document Number Error", p)).toBeNull();
    expect(shippingRefusalMessage("Shipping is not enabled", payloadOf(build(wo())))).toBeNull();
  });
});

describe("the work order's shipping charge", () => {
  it("reads the view row", () => {
    expect(
      toCustomerShipping({ work_order_id: A, fulfillment: "shipping", charge_shipping: true, filters: 2, egr_coolers: 1, filter_rate: "28.00", egr_rate: "34.00", automatic_amount: "90.00", override_amount: null, amount: "90.00" }),
    ).toMatchObject({ fulfillment: "shipping", chargeShipping: true, countedFrom: null, gesiFilters: 0, overnight: false, filters: 2, egrCoolers: 1, filterRate: 28, egrRate: 34, automaticAmount: 90, overrideAmount: null, amount: 90 });
    expect(toCustomerShipping(null)).toBeNull();
    expect(
      toCustomerShipping({
        fulfillment: "supplier_direct",
        charge_shipping: true,
        counted_from: "sold",
        filters: 1,
        egr_coolers: 0,
        gesi_filters: 2,
        overnight: true,
        filter_rate: "28.00",
        egr_rate: "34.00",
        gesi_unit_amount: "150.00",
        automatic_amount: "328.00",
        override_amount: null,
        box_amount: "28.00",
        gesi_amount: "300.00",
        amount: "328.00",
      }),
    ).toMatchObject({ countedFrom: "sold", filters: 1, gesiFilters: 2, overnight: true, gesiUnitAmount: 150, boxAmount: 28, gesiAmount: 300, amount: 328 });
  });

  it("parses the amount CDS types", () => {
    expect(parseShippingOverride("45.50")).toEqual({ ok: true, amount: 45.5 });
    expect(parseShippingOverride("$28")).toEqual({ ok: true, amount: 28 });
    expect(parseShippingOverride("0")).toEqual({ ok: true, amount: 0 });
    expect(parseShippingOverride("1,200")).toEqual({ ok: true, amount: 1200 });
    expect(parseShippingOverride("").ok).toBe(false);
    expect(parseShippingOverride("-1").ok).toBe(false);
    expect(parseShippingOverride("abc").ok).toBe(false);
    expect(parseShippingOverride("12.345").ok).toBe(false);
    expect(parseShippingOverride("100001").ok).toBe(false);
  });
});

describe("GESi filter sold: the Shipping and Handling (G) item line", () => {
  const gesi = (over: Partial<NonNullable<InvoiceWorkOrder["gesiShipping"]>> = {}) => ({ qty: 2, unitAmount: 28, amount: 56, overnight: false, ...over });

  it("is a normal item line before the Shipping box, named for the QuickBooks item, taxed as shipping", () => {
    const p = payloadOf(build(wo({ shippingCharge: 28, gesiShipping: gesi() })));
    expect(p.Line).toHaveLength(3);
    expect(p.Line[1]).toEqual({
      DetailType: "SalesItemLineDetail",
      Amount: 56,
      Description: "Shipping and Handling (G): 2 GESi filters x $28.00",
      SalesItemLineDetail: { ItemRef: { value: "", name: GESI_SHIPPING_ITEM_NAME }, Qty: 2, UnitPrice: 28, TaxCodeRef: { value: "TAX" } },
    });
    expect(p.Line[2].SalesItemLineDetail.ItemRef.value).toBe(SHIPPING_ITEM_ID);
    expect(shippingAmountOf(p)).toBe(28);
  });

  it("says overnight, follows Tax shipping, and is left off at 0", () => {
    const p = payloadOf(build(wo({ taxShipping: false, gesiShipping: gesi({ qty: 1, unitAmount: 150, amount: 150, overnight: true }) })));
    expect(p.Line[1]).toMatchObject({
      Amount: 150,
      Description: "Shipping and Handling (G): 1 GESi filter x $150.00 (overnight)",
      SalesItemLineDetail: { Qty: 1, UnitPrice: 150, TaxCodeRef: { value: "NON" } },
    });
    expect(payloadOf(build(wo({ gesiShipping: gesi({ amount: 0 }) }))).Line).toHaveLength(1);
    expect(payloadOf(build(wo({ gesiShipping: null }))).Line).toHaveLength(1);
  });

  it("is one line of the amount set by hand when it is not the automatic amount", () => {
    const p = payloadOf(build(wo({ gesiShipping: gesi({ amount: 100 }) })));
    expect(p.Line[1]).toMatchObject({
      Amount: 100,
      Description: "Shipping and Handling (G)",
      SalesItemLineDetail: { Qty: 1, UnitPrice: 100 },
    });
  });

  it("keeps each work order's GESi line on a combined invoice", () => {
    const r = buildCombinedInvoicePayload([part(wo({ gesiShipping: gesi() })), part(wo({ id: B, woNumber: 104102, shippingCharge: 28 }))]);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.payload.Line.map((l) => l.SalesItemLineDetail.ItemRef.name ?? l.SalesItemLineDetail.ItemRef.value)).toEqual([
      "DPF Cleaning",
      GESI_SHIPPING_ITEM_NAME,
      "DPF Cleaning",
      SHIPPING_ITEM_ID,
    ]);
  });

  const withItems = (items: { Id: string; Name: string; Active?: boolean }[] | Error): QboLookups => ({
    ...lookups({ AllowShipping: true }),
    findItemsByName: async () => {
      if (items instanceof Error) throw items;
      return items;
    },
  });

  it("gets the QuickBooks item id by its name before sending", async () => {
    const p = payloadOf(build(wo({ gesiShipping: gesi() })));
    const r = await resolveInvoiceQbo(withItems([{ Id: "912", Name: "Shipping and Handling (G)", Active: true }]), p, target, null);
    expect(r.payload.Line[1].SalesItemLineDetail.ItemRef).toEqual({ value: "912", name: "Shipping and Handling (G)" });
    // The built payload is not changed (the claim snapshot is taken from it).
    expect(p.Line[1].SalesItemLineDetail.ItemRef.value).toBe("");
  });

  it("stops with a message naming the item when QuickBooks has no such active item", async () => {
    const p = payloadOf(build(wo({ gesiShipping: gesi() })));
    await expect(resolveInvoiceQbo(withItems([]), p, target, null)).rejects.toBeInstanceOf(GesiShippingItemError);
    await expect(resolveInvoiceQbo(withItems([{ Id: "9", Name: "Shipping and Handling (G)", Active: false }]), p, target, null)).rejects.toThrow(
      /"Shipping and Handling \(G\)"/,
    );
    await expect(resolveInvoiceQbo(withItems(new Error("timeout")), p, target, null)).rejects.toBeInstanceOf(GesiShippingItemError);
    await expect(resolveInvoiceQbo(lookups({ AllowShipping: true }), p, target, null)).rejects.toBeInstanceOf(GesiShippingItemError);
  });

  it("needs no lookup without a GESi line", async () => {
    const p = payloadOf(build(wo({ shippingCharge: 28 })));
    const r = await resolveInvoiceQbo(withItems(new Error("not called")), p, target, null);
    expect(r.payload.Line).toHaveLength(2);
  });
});
