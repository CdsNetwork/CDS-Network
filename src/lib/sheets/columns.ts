/**
 * The columns of the "DISPATCH - APP BACK UP" sheet: one row per work order, keyed by the
 * WO number in column A. Wording follows CDS's own dispatch sheet (CDS INC DISPATCH 2026:
 * DATE, LOCATION, LICENSEE, UNIT #, PO #, PART NUMBER, SENT TO LIC., SHIPPING INFO, VENDOR
 * BILL, CUSTOMER BILL, PROFIT, FILTER MFG, Total Soot Remvd, FILTER QTY, FAIL,
 * Service/ Parts) where a portal field matches. It is CDS's internal sheet, so prices,
 * shop rates and margins are included. Pure: no database or network access.
 */
import { COMPONENT_RESULT_LABEL, date, dateTime, SHIPMENT_STATUS_LABEL, STATUS_LABEL, type WoStatus } from "@/lib/format";

export type Cell = string | number;

export type BackupLine = { sku: string; name: string; qty: number; shopUnitRate: number | null; customerUnitPrice: number | null };
export type BackupComponent = {
  type: string;
  manufacturer: string | null;
  partNumber: string | null;
  weightRemovedG: number | null;
  result: string | null;
  resultNote: string | null;
};
export type BackupShipment = { carrier: string | null; trackingNumber: string | null; status: string; cost: number | null };

/** Everything one row needs, already read from the database. */
export type BackupOrder = {
  woNumber: number;
  createdAt: string;
  status: WoStatus;
  customer: string | null;
  locationCode: string | null;
  location: string;
  shop: string | null;
  unitNumber: string;
  poNumber: string | null;
  vin: string | null;
  mileage: number | null;
  requestedWork: string;
  dispatchedAt: string | null;
  pickedUpAt: string | null;
  completedAt: string | null;
  deliveredAt: string | null;
  shopInvoiceRef: string | null;
  supplierCostTbd: boolean;
  invoiceNumber: string | null;
  invoicedAt: string | null;
  updatedAt: string;
  lines: BackupLine[];
  components: BackupComponent[];
  shipments: BackupShipment[];
};

export const HEADER = [
  "WO #",
  "DATE",
  "STATUS",
  "CUSTOMER",
  "LOCATION CODE",
  "LOCATION",
  "LICENSEE",
  "UNIT #",
  "PO #",
  "VIN",
  "MILEAGE",
  "REQUESTED WORK",
  "Service/ Parts",
  "PART NUMBER",
  "FILTER MFG",
  "FILTER QTY",
  "Total Soot Remvd (g)",
  "FAIL",
  "SENT TO LIC.",
  "SENT ARRIVAL / PICKED UP",
  "COMPLETED",
  "DELIVERED",
  "SHIPPING INFO",
  "Shipping cost",
  "VENDOR BILL",
  "VENDOR BILL $ AMT",
  "CUSTOMER BILL",
  "CUSTOMER BILL $ AMT",
  "PROFIT",
  "INVOICED",
  "LAST UPDATED (PT)",
] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (v: string | null) => (v ? date(v) : "");
const uniq = (values: (string | null | undefined)[]) => [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))];

/** The row of one work order, in HEADER order. Empty cells are "". */
export function toRow(o: BackupOrder): Cell[] {
  const shopTotal = round2(o.lines.reduce((s, l) => s + (l.shopUnitRate ?? 0) * l.qty, 0));
  const customerTotal = round2(o.lines.reduce((s, l) => s + (l.customerUnitPrice ?? 0) * l.qty, 0));
  const shippingCosts = o.shipments.map((s) => s.cost).filter((c): c is number => c != null);
  const shipping = round2(shippingCosts.reduce((s, c) => s + c, 0));
  const filters = o.components.filter((c) => c.type !== "EGR");
  const soot = filters.map((c) => c.weightRemovedG).filter((w): w is number => w != null);
  const failed = o.components
    .filter((c) => c.result === "failed" || c.result === "condemned")
    .map((c) => `${c.type} ${COMPONENT_RESULT_LABEL[c.result!] ?? c.result}${c.resultNote ? `: ${c.resultNote}` : ""}`);

  const row: Cell[] = [
    o.woNumber,
    day(o.createdAt),
    STATUS_LABEL[o.status] ?? o.status,
    o.customer ?? "",
    o.locationCode ?? "",
    o.location,
    o.shop ?? "",
    o.unitNumber,
    o.poNumber ?? "",
    o.vin ?? "",
    o.mileage ?? "",
    o.requestedWork,
    o.lines.map((l) => `${l.qty} x ${l.sku} ${l.name}`).join("; "),
    uniq(o.components.map((c) => c.partNumber)).join("; "),
    uniq(o.components.map((c) => c.manufacturer)).join("; "),
    filters.length || "",
    soot.length ? round2(soot.reduce((s, w) => s + w, 0)) : "",
    failed.join("; "),
    day(o.dispatchedAt),
    day(o.pickedUpAt),
    day(o.completedAt),
    day(o.deliveredAt),
    o.shipments
      .map((s) => [s.carrier, s.trackingNumber, SHIPMENT_STATUS_LABEL[s.status] ?? s.status].filter(Boolean).join(" "))
      .join("; "),
    shippingCosts.length ? shipping : "",
    o.shopInvoiceRef ?? "",
    o.lines.length ? (o.supplierCostTbd ? "TBD" : shopTotal) : "",
    o.invoiceNumber ?? "",
    o.lines.length ? customerTotal : "",
    o.lines.length ? (o.supplierCostTbd ? "TBD" : round2(customerTotal - shopTotal - shipping)) : "",
    day(o.invoicedAt),
    dateTime(o.updatedAt).replace(/ PT$/, ""),
  ];
  return row.map((c) => (typeof c === "string" ? c.slice(0, 5000) : c));
}

/** Column letter of a 1-based index (1 -> A, 27 -> AA). */
export function columnLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Cells compare as the sheet shows them: 21.5 equals "21.5", a missing cell equals "". */
export function sameRow(a: readonly unknown[], b: readonly unknown[], width = HEADER.length): boolean {
  for (let i = 0; i < width; i++) if (String(a[i] ?? "") !== String(b[i] ?? "")) return false;
  return true;
}
