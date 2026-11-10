import { isTaxable, type TaxClass } from "@/lib/tax";
import type { QboCustomField } from "./custom-fields";
import type { QboAddress } from "./sub-customer";

/**
 * Builds the QuickBooks Online Invoice for a work order. Pure: no database, no network.
 *
 * Invoice fields: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
 * Sales tax (US, Automated Sales Tax):
 * https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-sales-tax-for-us-locales
 * https://developer.intuit.com/app/developer/qbo/docs/workflows/calculate-sales-tax/automated-sales-tax-for-us-locales
 * (Intuit notes that sandbox companies do not run the Automated Sales Tax engine, so tax
 * amounts can only be checked against a production company.)
 *   * QuickBooks calculates the tax from the invoice ShipAddr (the company address when
 *     there is none), so the ship-to address must be complete.
 *   * Each line says only whether it is taxable: SalesItemLineDetail.TaxCodeRef "TAX" or
 *     "NON". TxnTaxDetail is not sent: overriding the calculated tax is unreliable.
 * DocNumber is not sent, so QuickBooks numbers the invoice itself.
 *
 * QuickBooks items can be per customer (CDS has "EVACUFLUSH AND BAKE DPF - RYDER" next to
 * "... - ENTERPRISE"): a catalog item mapped for the work order's customer wins over the
 * mapping for all customers. After the billable lines, each component gets a $0
 * "measurements" line (per customer and component type) with its readings.
 *
 * A customer's own part number (customer_item_aliases, required by First Student's
 * Basware portal) goes in front of the line description, with the customer's own
 * description when there is one. Items priced per line (Misc. hardware: the amount from
 * the shop's invoice, billed as is) are ordinary lines whose description adds the text CDS
 * entered on the line.
 */

export { isTaxable, type TaxClass };

export type InvoiceWorkOrder = {
  id: string;
  woNumber: number;
  market: string;
  customerName: string;
  poNumber: string | null;
  unitNumber: string | null;
  /** The work order's tax flags (work_order_internal). */
  taxParts: boolean;
  taxLabor: boolean;
  taxShipping: boolean;
  /** customer_billing.tax_exempt: every line is non-taxable. */
  customerTaxExempt: boolean;
};

export type InvoiceLine = {
  catalogItemId: string;
  sku: string;
  name: string;
  /** work_order_lines.description: text CDS entered on the line (Misc. hardware). */
  description?: string | null;
  qty: number;
  /** work_order_line_pricing.customer_unit_price; null when the snapshot is missing. */
  customerUnitPrice: number | null;
  taxClass: TaxClass;
};

/** customer_item_aliases: the customer's own part number and description for one of our items. */
export type CustomerAlias = { partNumber: string; description?: string | null };

export type CustomerMapping = { qboCustomerId: string; qboDisplayName: string };
export type ItemMapping = {
  qboItemId: string;
  qboItemName: string;
  /** qbo_item_descriptions: the invoice text for this QuickBooks item, used instead of our item name. */
  invoiceDescription?: string | null;
};

/** The QuickBooks items for the catalog items on one work order, by catalog item id. */
export type ItemMappings = {
  /** Mapped for this work order's customer (qbo_item_map.customer_id = the customer). */
  customer: Record<string, ItemMapping | undefined>;
  /** Mapped for all customers (qbo_item_map.customer_id is null). */
  default: Record<string, ItemMapping | undefined>;
  /** Catalog items that are mapped for some other customer (used to explain a missing link). */
  otherCustomers?: Record<string, boolean | undefined>;
};

export type ComponentType = "DPF" | "DOC" | "SCR" | "EGR";
export type ComponentResult = "cleaned" | "passed" | "failed" | "condemned";

export type InvoiceComponent = {
  seq: number;
  componentType: ComponentType;
  manufacturer: string | null;
  partNumber: string | null;
  serialNumber: string | null;
  dpBefore: number | null;
  dpAfter: number | null;
  weightBeforeG: number | null;
  weightAfterG: number | null;
  weightRemovedG: number | null;
  result: ComponentResult | null;
};

/** The $0 measurement items by component type (qbo_measurement_map). */
export type MeasurementMappings = {
  customer: Partial<Record<ComponentType, ItemMapping>>;
  default: Partial<Record<ComponentType, ItemMapping>>;
};

export type InvoiceLocation = {
  label: string;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
};

type Ref = { value: string; name?: string };

export type QboInvoiceLine = {
  DetailType: "SalesItemLineDetail";
  Amount: number;
  Description: string;
  SalesItemLineDetail: { ItemRef: Ref; Qty: number; UnitPrice: number; TaxCodeRef: { value: "TAX" | "NON" } };
};

export type QboInvoicePayload = {
  CustomerRef: Ref;
  /** Set when the invoice goes to a sub-customer: the parent's billing address (see ./invoice-qbo). */
  BillAddr?: QboAddress;
  /** "Fleet Number" and "PO Number" (see ./custom-fields). */
  CustomField?: QboCustomField[];
  ShipAddr: { Line1: string; City: string; CountrySubDivisionCode: string; PostalCode: string; Country: "US" };
  Line: QboInvoiceLine[];
  PrivateNote: string;
  CustomerMemo?: { value: string };
};

/** Problems block the invoice; warnings do not (they are shown next to the button). */
export type BuildResult =
  | { ok: true; payload: QboInvoicePayload; warnings: string[] }
  | { ok: false; problems: string[]; warnings: string[] };

/** QuickBooks limit for a line description. */
const DESCRIPTION_MAX = 4000;

const RESULT_TEXT: Record<ComponentResult, string> = {
  cleaned: "Cleaned Successfully",
  passed: "Pass",
  failed: "Fail",
  condemned: "Condemned",
};

const ZIP = /^\d{5}(-\d{4})?$/;
const STATE = /^[A-Z]{2}$/;

/** Money to cents without binary rounding surprises (1.005 -> 1.01). */
export function cents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function mapped(m: ItemMapping | undefined): m is ItemMapping {
  return !!m?.qboItemId?.trim();
}

/** A reading without trailing zeros (15250.0 -> "15250"); null when there is none. */
function reading(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : null;
}

/**
 * The description of a component's measurement line, for example
 * "Manufacturer: X\nPart Number: Y\n...\nResult: Cleaned Successfully", one reading per line
 * (QuickBooks keeps the line breaks). Empty fields are left out; EGR coolers have no
 * measurements, only Pass or Fail.
 */
export function measurementDescription(c: InvoiceComponent): string {
  const egr = c.componentType === "EGR";
  const removed =
    c.weightRemovedG ?? (c.weightBeforeG !== null && c.weightAfterG !== null ? Number(c.weightBeforeG) - Number(c.weightAfterG) : null);
  const grams = (n: number | null) => {
    const r = reading(n);
    return r === null ? null : `${r} g`;
  };
  const fields: [string, string | null][] = [
    ["Manufacturer", c.manufacturer?.trim() || null],
    ["Part Number", c.partNumber?.trim() || null],
    ["Serial Number", c.serialNumber?.trim() || null],
    ...(egr
      ? []
      : ([
          ["Pressure before", reading(c.dpBefore)],
          ["Pressure after", reading(c.dpAfter)],
          ["Weight before", grams(c.weightBeforeG)],
          ["Weight after", grams(c.weightAfterG)],
          ["Weight removed", grams(removed)],
        ] as [string, string | null][])),
    ["Result", c.result && (!egr || c.result === "passed" || c.result === "failed") ? RESULT_TEXT[c.result] : null],
  ];
  const text = fields
    .filter((f): f is [string, string] => !!f[1])
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
  return clip(text || `${c.componentType} #${c.seq}`, DESCRIPTION_MAX);
}

/**
 * The invoice line description: the customer's own description (with its part number), else
 * the invoice text of the QuickBooks item (qbo_item_descriptions), else our item name; then
 * the text entered on the line, and the customer's part number in front when there is one.
 */
export function lineDescription(
  line: Pick<InvoiceLine, "name" | "description">,
  alias?: CustomerAlias,
  itemDescription?: string | null,
): string {
  const partNumber = alias?.partNumber?.trim();
  const name = (partNumber && alias?.description?.trim()) || itemDescription?.trim() || line.name;
  const text = [name, line.description?.trim()].filter(Boolean).join(" - ");
  return clip(partNumber ? `Part # ${partNumber} - ${text}` : text, DESCRIPTION_MAX);
}

/**
 * The QuickBooks invoice for a work order, or the list of things CDS must fix first
 * (written for the person looking at the work order).
 *
 * @param aliases the customer's own part numbers (and descriptions) by catalog item id
 */
export function buildInvoicePayload(
  workOrder: InvoiceWorkOrder,
  lines: InvoiceLine[],
  customerMap: CustomerMapping | null,
  itemMap: ItemMappings,
  aliases: Record<string, CustomerAlias | undefined>,
  location: InvoiceLocation | null,
  components: InvoiceComponent[] = [],
  measurementMap: MeasurementMappings = { customer: {}, default: {} },
): BuildResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (workOrder.market !== "US") {
    problems.push("QuickBooks invoices are set up for US work orders only.");
  }
  if (!customerMap?.qboCustomerId?.trim()) {
    problems.push(`${workOrder.customerName} is not linked to a QuickBooks customer. Link it on Admin > QuickBooks mappings.`);
  }

  // Ship-to: QuickBooks taxes the invoice by this address.
  let shipAddr: QboInvoicePayload["ShipAddr"] | null = null;
  if (!location) {
    problems.push("The work order has no customer location, so there is no ship-to address for sales tax.");
  } else {
    const line1 = location.addressLine1?.trim() ?? "";
    const city = location.city?.trim() ?? "";
    const region = location.region?.trim().toUpperCase() ?? "";
    const zip = location.postalCode?.trim() ?? "";
    const country = (location.country?.trim() || "US").toUpperCase();
    const missing = [!line1 && "street", !city && "city", !STATE.test(region) && "2-letter state"].filter(Boolean);
    if (missing.length) {
      problems.push(`Location ${location.label} needs its ${missing.join(", ")} filled in (Admin > Locations).`);
    }
    if (!ZIP.test(zip)) {
      problems.push(`Location ${location.label} needs a 5-digit ZIP code (Admin > Locations).`);
    }
    if (country !== "US") {
      problems.push(`Location ${location.label} is not in the US.`);
    }
    if (!missing.length && ZIP.test(zip) && country === "US") {
      shipAddr = { Line1: clip(line1, 500), City: clip(city, 255), CountrySubDivisionCode: region, PostalCode: zip, Country: "US" };
    }
  }

  if (!lines.length) problems.push("The work order has no lines to invoice.");

  const unmapped = new Set<string>();
  const qboLines: QboInvoiceLine[] = [];
  for (const l of lines) {
    const forCustomer = itemMap.customer[l.catalogItemId];
    const forAll = itemMap.default[l.catalogItemId];
    const item = mapped(forCustomer) ? forCustomer : mapped(forAll) ? forAll : null;
    if (!item) {
      if (!unmapped.has(l.catalogItemId)) {
        unmapped.add(l.catalogItemId);
        const who = workOrder.customerName;
        problems.push(
          itemMap.otherCustomers?.[l.catalogItemId]
            ? `${l.sku} ${l.name} is not linked to a QuickBooks item for ${who} (it is linked for other customers only). Link it for ${who} or for all customers on Admin > QuickBooks mappings.`
            : `${l.sku} ${l.name} is not linked to a QuickBooks item. Link it on Admin > QuickBooks mappings.`,
        );
      }
      continue;
    }
    if (l.customerUnitPrice === null || !Number.isFinite(Number(l.customerUnitPrice)) || Number(l.customerUnitPrice) < 0) {
      problems.push(`${l.sku} has no customer price.`);
      continue;
    }
    if (!(l.qty > 0)) {
      problems.push(`${l.sku} has no quantity.`);
      continue;
    }
    const unitPrice = Number(l.customerUnitPrice);
    qboLines.push({
      DetailType: "SalesItemLineDetail",
      Amount: cents(l.qty * unitPrice),
      Description: lineDescription(l, aliases[l.catalogItemId], item.invoiceDescription),
      SalesItemLineDetail: {
        ItemRef: { value: item.qboItemId, name: item.qboItemName },
        Qty: l.qty,
        UnitPrice: unitPrice,
        TaxCodeRef: { value: isTaxable(l.taxClass, workOrder) ? "TAX" : "NON" },
      },
    });
  }

  // $0 measurement lines, one per component in seq order. A component type without a
  // measurement item is left off with a warning: it must not stop the invoice.
  const skipped = new Map<ComponentType, string[]>();
  for (const c of [...components].sort((a, b) => a.seq - b.seq)) {
    const forCustomer = measurementMap.customer[c.componentType];
    const forAll = measurementMap.default[c.componentType];
    const item = mapped(forCustomer) ? forCustomer : mapped(forAll) ? forAll : null;
    if (!item) {
      skipped.set(c.componentType, [...(skipped.get(c.componentType) ?? []), `${c.componentType} #${c.seq}`]);
      continue;
    }
    qboLines.push({
      DetailType: "SalesItemLineDetail",
      Amount: 0,
      Description: measurementDescription(c),
      SalesItemLineDetail: {
        ItemRef: { value: item.qboItemId, name: item.qboItemName },
        Qty: 1,
        UnitPrice: 0,
        TaxCodeRef: { value: "NON" },
      },
    });
  }
  for (const [type, labels] of skipped) {
    warnings.push(
      `No QuickBooks measurement item for ${type} (${workOrder.customerName} or all customers), so ${labels.join(", ")} measurements are not on the invoice. Map one on Admin > QuickBooks mappings.`,
    );
  }

  if (problems.length || !customerMap || !shipAddr) return { ok: false, problems, warnings };

  const po = workOrder.poNumber?.trim();
  const unit = workOrder.unitNumber?.trim();
  // The PO goes in the internal note (always) and in the message on the invoice the customer
  // sees. The "Fleet Number" and "PO Number" custom fields are added when the invoice is
  // sent, once QuickBooks has told us their DefinitionIds (./invoice-qbo).
  const memo = [po && `PO ${po}`, unit && `Unit ${unit}`].filter(Boolean).join(" | ");
  return {
    ok: true,
    payload: {
      CustomerRef: { value: customerMap.qboCustomerId, name: customerMap.qboDisplayName },
      ShipAddr: shipAddr,
      Line: qboLines,
      PrivateNote: clip([`Portal WO-${workOrder.woNumber}`, po && `PO ${po}`].filter(Boolean).join(" | "), 4000),
      ...(memo ? { CustomerMemo: { value: clip(memo, 1000) } } : {}),
    },
    warnings,
  };
}
