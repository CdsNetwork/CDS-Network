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
 */

export type TaxClass = "parts" | "labor" | "shipping" | "exempt";

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
  qty: number;
  /** work_order_line_pricing.customer_unit_price; null when the snapshot is missing. */
  customerUnitPrice: number | null;
  taxClass: TaxClass;
};

export type CustomerMapping = { qboCustomerId: string; qboDisplayName: string };
export type ItemMapping = { qboItemId: string; qboItemName: string };

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
  ShipAddr: { Line1: string; City: string; CountrySubDivisionCode: string; PostalCode: string; Country: "US" };
  Line: QboInvoiceLine[];
  PrivateNote: string;
  CustomerMemo?: { value: string };
};

export type BuildResult = { ok: true; payload: QboInvoicePayload } | { ok: false; problems: string[] };

const ZIP = /^\d{5}(-\d{4})?$/;
const STATE = /^[A-Z]{2}$/;

/** Money to cents without binary rounding surprises (1.005 -> 1.01). */
export function cents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function isTaxable(taxClass: TaxClass, wo: Pick<InvoiceWorkOrder, "taxParts" | "taxLabor" | "taxShipping" | "customerTaxExempt">): boolean {
  if (wo.customerTaxExempt) return false;
  switch (taxClass) {
    case "parts":
      return wo.taxParts;
    case "labor":
      return wo.taxLabor;
    case "shipping":
      return wo.taxShipping;
    default:
      return false;
  }
}

/**
 * The QuickBooks invoice for a work order, or the list of things CDS must fix first
 * (written for the person looking at the work order).
 *
 * @param aliases the customer's own part numbers by catalog item id
 */
export function buildInvoicePayload(
  workOrder: InvoiceWorkOrder,
  lines: InvoiceLine[],
  customerMap: CustomerMapping | null,
  itemMap: Record<string, ItemMapping | undefined>,
  aliases: Record<string, string | undefined>,
  location: InvoiceLocation | null,
): BuildResult {
  const problems: string[] = [];

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
    const item = itemMap[l.catalogItemId];
    if (!item?.qboItemId?.trim()) {
      if (!unmapped.has(l.catalogItemId)) {
        unmapped.add(l.catalogItemId);
        problems.push(`${l.sku} ${l.name} is not linked to a QuickBooks item. Link it on Admin > QuickBooks mappings.`);
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
    const alias = aliases[l.catalogItemId]?.trim();
    qboLines.push({
      DetailType: "SalesItemLineDetail",
      Amount: cents(l.qty * unitPrice),
      Description: clip(alias ? `Part # ${alias} - ${l.name}` : l.name, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: item.qboItemId, name: item.qboItemName },
        Qty: l.qty,
        UnitPrice: unitPrice,
        TaxCodeRef: { value: isTaxable(l.taxClass, workOrder) ? "TAX" : "NON" },
      },
    });
  }

  if (problems.length || !customerMap || !shipAddr) return { ok: false, problems };

  const po = workOrder.poNumber?.trim();
  const unit = workOrder.unitNumber?.trim();
  // Custom fields need per-company setup, so the PO goes in the internal note (always) and
  // in the message on the invoice the customer sees.
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
  };
}
