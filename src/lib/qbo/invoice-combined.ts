import { woLabel } from "@/lib/format";
import { isTaxable } from "@/lib/tax";
import { shippingLine } from "./invoice-shipping";
import {
  buildInvoicePayload,
  cents,
  type BuildResult,
  type CustomerAlias,
  type CustomerMapping,
  type InvoiceComponent,
  type InvoiceLine,
  type InvoiceLocation,
  type InvoiceRefs,
  type InvoiceWorkOrder,
  type ItemMappings,
  type MeasurementMappings,
  type QboInvoicePayload,
} from "./invoice";

/**
 * One order across 2 shops (CDS, 2026-11-17, milestone M4): two linked work orders
 * (public.work_order_links) get ONE customer invoice in QuickBooks with the lines of both.
 * Each shop still gets its own bill (./bill, unchanged). Pure: no database, no network.
 *
 * The invoice is the one ./invoice builds for each work order, joined:
 *   * the header (customer, ship-to, Division, Class, PO, unit) is the first work order's: the
 *     one with the lowest WO number, which also owns the invoice claim
 *     (20261119080000_combined_invoice.sql). The customer, location and PO must be the same on
 *     both, and the unit too when both have one; the Class is the first work order's shop,
 *     since CDS's company has one Class per invoice;
 *   * the lines are the first work order's (billable, then measurements), then the other's,
 *     each taxed by its own work order's tax settings;
 *   * the internal note names both WO numbers ("Portal WO-104101 + WO-104102 | PO ...");
 *   * one Shipping box with the sum of both work orders' shipping charges, taxed by the
 *     "Tax shipping" setting of the order(s) that have a charge (CDS must align the setting
 *     when both have a charge and tax it differently).
 * Both work orders must be ready to invoice by today's rules (./invoice-lock): not cancelled,
 * not invoiced, no QuickBooks invoice of their own. CDS may invoice before a shop completes,
 * as for one work order.
 */

export type LinkRow = { work_order_id: string; linked_work_order_id: string };

export type InvoiceGroup = { kind: "solo" } | { kind: "pair"; linkedId: string } | { kind: "too_many"; ids: string[] };

/** The work orders one invoice covers, from the link rows that touch the order or the one linked to it. */
export function invoiceGroup(woId: string, links: LinkRow[]): InvoiceGroup {
  const seen = new Set<string>([woId]);
  const queue = [woId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const l of links) {
      const other = l.work_order_id === id ? l.linked_work_order_id : l.linked_work_order_id === id ? l.work_order_id : null;
      if (other && !seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  if (seen.size === 1) return { kind: "solo" };
  if (seen.size === 2) return { kind: "pair", linkedId: [...seen].find((x) => x !== woId)! };
  return { kind: "too_many", ids: [...seen].sort() };
}

/** Told to CDS when more than two work orders are linked together. */
export function tooManyLinkedMessage(woNumber: number): string {
  return `${woLabel(woNumber)} is linked to more than one other work order. One QuickBooks invoice covers two linked work orders: remove the extra link first.`;
}

/** Everything ./invoice needs for one work order, plus what the two are compared on. */
export type InvoicePart = {
  workOrder: InvoiceWorkOrder;
  status: string;
  qbInvoiceId: string | null;
  customerId: string;
  locationId: string | null;
  lines: InvoiceLine[];
  customerMap: CustomerMapping | null;
  itemMap: ItemMappings;
  aliases: Record<string, CustomerAlias | undefined>;
  location: InvoiceLocation | null;
  components: InvoiceComponent[];
  measurementMap: MeasurementMappings;
  refs: InvoiceRefs;
};

export type CombinedBuildResult =
  | (Extract<BuildResult, { ok: true }> & { primaryId: string; unitNumber: string | null })
  | Extract<BuildResult, { ok: false }>;

/**
 * Why the linked work order is not ready for the invoice of both, or null when it is
 * (the same rules as one work order, ./invoice-lock). `own` is the WO number of the other one.
 */
export function linkedReadiness(o: { woNumber: number; status: string; qbInvoiceId: string | null }, own: number): string | null {
  const label = woLabel(o.woNumber);
  const alone = `Remove the link to invoice ${woLabel(own)} on its own.`;
  if (o.qbInvoiceId) return `${label} already has its own QuickBooks invoice ${o.qbInvoiceId}. ${alone}`;
  if (o.status === "invoiced") return `${label} is already invoiced. ${alone}`;
  if (o.status === "cancelled") return `${label} is cancelled. ${alone}`;
  return null;
}

/** The QuickBooks internal note: both WO numbers, then the PO. */
export function combinedPrivateNote(woNumbers: number[], poNumber: string | null): string {
  const wos = [...woNumbers].sort((a, b) => a - b).map(woLabel).join(" + ");
  const po = poNumber?.trim();
  return [`Portal ${wos}`, po && `PO ${po}`].filter(Boolean).join(" | ").slice(0, 4000);
}

const samePo = (a: string | null, b: string | null) => (a?.trim().toUpperCase() ?? "") === (b?.trim().toUpperCase() ?? "");

/** The two work orders by WO number: the first one gives the header. */
export function byWoNumber<T extends { workOrder: { woNumber: number } }>(parts: [T, T]): [T, T] {
  return parts[0].workOrder.woNumber <= parts[1].workOrder.woNumber ? [parts[0], parts[1]] : [parts[1], parts[0]];
}

/** The unit for the Fleet Number and the invoice message: the first work order's, else the other's. */
export function combinedUnit(parts: [InvoicePart, InvoicePart]): string | null {
  const [a, b] = byWoNumber(parts);
  return a.workOrder.unitNumber?.trim() || b.workOrder.unitNumber?.trim() || null;
}

/** Why the two work orders cannot share one invoice header. */
function mismatches(a: InvoicePart, b: InvoicePart): string[] {
  const la = woLabel(a.workOrder.woNumber);
  const lb = woLabel(b.workOrder.woNumber);
  const out: string[] = [];
  if (a.customerId !== b.customerId) {
    out.push(`${la} is for ${a.workOrder.customerName} and ${lb} is for ${b.workOrder.customerName}. One invoice is for one customer: correct the customer or remove the link.`);
  }
  if (a.locationId !== b.locationId) {
    out.push(
      `${la} is for location ${a.location?.label ?? "(none)"} and ${lb} for ${b.location?.label ?? "(none)"}. One invoice has one ship-to address: correct the location or remove the link.`,
    );
  }
  if (!samePo(a.workOrder.poNumber, b.workOrder.poNumber)) {
    const po = (w: InvoiceWorkOrder) => (w.poNumber?.trim() ? `PO ${w.poNumber.trim()}` : "no PO");
    out.push(`${la} has ${po(a.workOrder)} and ${lb} has ${po(b.workOrder)}. One invoice has one PO: correct the PO or remove the link.`);
  }
  const ua = a.workOrder.unitNumber?.trim();
  const ub = b.workOrder.unitNumber?.trim();
  if (ua && ub && ua.toUpperCase() !== ub.toUpperCase()) {
    out.push(`${la} is for unit ${ua} and ${lb} for unit ${ub}. One invoice has one Fleet Number: correct the unit or remove the link.`);
  }
  return out;
}

/** Messages of both work orders, each once, with the WO numbers it is about in front. */
function labelled(byPart: { label: string; messages: string[] }[]): string[] {
  const order: string[] = [];
  const who = new Map<string, string[]>();
  for (const { label, messages } of byPart) {
    for (const m of messages) {
      if (!who.has(m)) {
        who.set(m, []);
        order.push(m);
      }
      who.get(m)!.push(label);
    }
  }
  return order.map((m) => `${who.get(m)!.join(" and ")}: ${m}`);
}

/**
 * The QuickBooks invoice for two linked work orders, or what CDS must fix first (written for
 * the person on either work order page). The order of `parts` does not matter.
 */
export function buildCombinedInvoicePayload(parts: [InvoicePart, InvoicePart]): CombinedBuildResult {
  const [first, second] = byWoNumber(parts);
  const unit = combinedUnit(parts);
  const readiness = [
    linkedReadiness({ woNumber: first.workOrder.woNumber, status: first.status, qbInvoiceId: first.qbInvoiceId }, second.workOrder.woNumber),
    linkedReadiness({ woNumber: second.workOrder.woNumber, status: second.status, qbInvoiceId: second.qbInvoiceId }, first.workOrder.woNumber),
  ].filter((m): m is string => !!m);
  const header = mismatches(first, second);

  // Each part is built without its shipping charge: the invoice has one Shipping box, added below.
  const build = (p: InvoicePart, workOrder: InvoiceWorkOrder) =>
    buildInvoicePayload({ ...workOrder, shippingCharge: 0 }, p.lines, p.customerMap, p.itemMap, p.aliases, p.location, p.components, p.measurementMap, p.refs);
  const a = build(first, { ...first.workOrder, unitNumber: unit });
  const b = build(second, second.workOrder);
  const la = woLabel(first.workOrder.woNumber);
  const lb = woLabel(second.workOrder.woNumber);
  const shipping = combinedShipping(first, second);
  const problems = [
    ...readiness,
    ...header,
    ...shipping.problems,
    ...labelled([
      { label: la, messages: a.ok ? [] : a.problems },
      { label: lb, messages: b.ok ? [] : b.problems },
    ]),
  ];
  const warnings = labelled([
    { label: la, messages: a.warnings },
    { label: lb, messages: b.warnings },
  ]);
  if (problems.length || !a.ok || !b.ok) return { ok: false, problems, warnings };

  const payload: QboInvoicePayload = {
    ...a.payload,
    Line: [...a.payload.Line, ...b.payload.Line, ...(shipping.amount > 0 ? [shippingLine(shipping.amount, shipping.taxable)] : [])],
    PrivateNote: combinedPrivateNote([first.workOrder.woNumber, second.workOrder.woNumber], first.workOrder.poNumber),
  };
  const itemText = [...a.itemText, ...b.itemText.map((t) => ({ ...t, index: t.index + a.payload.Line.length }))];
  return { ok: true, payload, warnings, itemText, primaryId: first.workOrder.id, unitNumber: unit };
}

/**
 * The Shipping box of the invoice of both: the sum of the two charges. It is taxable as the
 * order(s) with a charge say; when both have a charge and one taxes shipping and the other
 * does not, CDS is asked to align the setting (one line has one tax code).
 */
function combinedShipping(first: InvoicePart, second: InvoicePart): { amount: number; taxable: boolean; problems: string[] } {
  const charge = (p: InvoicePart) => p.workOrder.shippingCharge ?? 0;
  const invalid = [first, second].filter((p) => !Number.isFinite(charge(p)) || charge(p) < 0);
  if (invalid.length) {
    return {
      amount: 0,
      taxable: false,
      problems: invalid.map((p) => `${woLabel(p.workOrder.woNumber)}: the shipping charge must be an amount of $0 or more. Correct it in the Customer invoice box.`),
    };
  }
  const charged = [first, second].filter((p) => charge(p) > 0);
  const amount = cents(charge(first) + charge(second));
  const taxes = charged.map((p) => isTaxable("shipping", p.workOrder));
  if (taxes.length === 2 && taxes[0] !== taxes[1]) {
    const [yes, no] = taxes[0] ? [first, second] : [second, first];
    return {
      amount,
      taxable: false,
      problems: [
        `${woLabel(yes.workOrder.woNumber)} taxes shipping and ${woLabel(no.workOrder.woNumber)} does not, but one invoice has one Shipping box. Set Tax shipping the same on both work orders.`,
      ],
    };
  }
  return { amount, taxable: taxes[0] ?? false, problems: [] };
}

/**
 * The "Customer invoice & tax" box of a work order whose QuickBooks invoice covers both
 * linked work orders: the tax and total QuickBooks returned are for both, so the labels say
 * so (the subtotal above them is this work order's own lines). Unchanged otherwise.
 */
export function combinedTaxView<T extends { taxLabel: string; totalLabel: string; note: string | null }>(
  view: T,
  recorded: boolean,
  woNumbers: number[] | null,
): T {
  if (!recorded || !woNumbers || woNumbers.length < 2) return view;
  const both = [...woNumbers].sort((a, b) => a - b).map(woLabel).join(" + ");
  return {
    ...view,
    taxLabel: `${view.taxLabel}, ${both}`,
    totalLabel: `Combined invoice total (${both})`,
    note: [view.note, `One QuickBooks invoice covers ${both}: its tax and total are for both work orders.`].filter(Boolean).join(" "),
  };
}
