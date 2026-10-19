/**
 * First Student purchase orders from Infor iProcure ("New Purchase Order FSTL... from First
 * Student Company"). Used for parts orders and for cleanings. Item numbers are CDS SKUs or
 * First Student's own item numbers (customer aliases); the PO carries its own price.
 */
import { amount, countLabels, isoDate, present, readLabels, type TemplateItem, type TemplateResult } from "./common";

const SUBJECT = /\bNew Purchase Order\s+\S+\s+from First Student\b/i;
const HEADER = ["PO Number", "Order Description", "Total", "Buyer", "Contact Name", "E-Mail", "Email", "Ship To Address", "Ship To"] as const;
const LINE = ["Line Number", "Item Number", "Description", "Required Date", "Price", "UOM", "Quantity Requested", "Quantity", "Taxable", "Cost Center", "Supplier Item Number"] as const;

export function isFirstStudentIprocure(subject: string, text: string): boolean {
  return SUBJECT.test(subject) && countLabels(text, ["PO Number", "Item Number"]) === 2;
}

/** "First Student 11224 Warwick - MM": the location code, its name and the suffix. */
export function firstStudentShipTo(line: string | null | undefined): { code: string; name: string | null; suffix: string | null } | null {
  const m = line?.match(/First Student\s+(\d{3,6})\b\s*(.*?)\s*(?:-\s*([A-Z]{1,4}))?\s*$/i);
  if (!m) return null;
  return { code: m[1], name: m[2] || null, suffix: m[3] ? m[3].toUpperCase() : null };
}

const UNIT_IN_DESCRIPTION = /\b(?:unit|bus|truck|vehicle|veh)\s*(?:#|no\.?)?\s*:?\s*([A-Z0-9-]*\d[A-Z0-9-]*)\b/i;

export function parseFirstStudentIprocure(text: string): TemplateResult {
  const parts = text.split(/^(?=[ \t]*Line Number\b)/im);
  const head = readLabels(parts[0], HEADER, ["Ship To Address", "Ship To"]);
  const warnings: string[] = [];

  const items: TemplateItem[] = [];
  for (const block of parts.slice(1)) {
    const l = readLabels(block, LINE);
    const partNumber = l["Item Number"] ?? l["Supplier Item Number"];
    if (!partNumber && !l.Description) continue;
    const qty = amount(l["Quantity Requested"] ?? l.Quantity);
    const taxable = l.Taxable === null ? null : /^(1|y|yes|true)$/i.test(l.Taxable);
    items.push({
      description: l.Description ?? partNumber ?? "",
      partNumber,
      qty: qty && qty > 0 && qty < 1000 ? Math.round(qty) : 1,
      component: null,
      service: false,
      price: amount(l.Price),
      requiredDate: isoDate(l["Required Date"]),
      taxable,
      costCenter: l["Cost Center"],
    });
  }
  if (!items.length) warnings.push("No PO lines found: add the lines by hand.");

  const shipToLines = (head["Ship To Address"] ?? head["Ship To"] ?? "").split("\n").filter(Boolean);
  const shipTo = firstStudentShipTo(shipToLines[0]);
  const address = (shipTo ? shipToLines.slice(1) : shipToLines).join(", ") || null;
  const dates = items.map((i) => i.requiredDate).filter((d): d is string => !!d).sort();
  const costCenters = [...new Set(items.map((i) => i.costCenter).filter((c): c is string => !!c))];
  const description = head["Order Description"];

  return {
    template: "first_student_iprocure",
    customer: { codes: ["FIRST_STUDENT"], names: ["First Student"], label: "First Student" },
    fields: present({
      po_number: head["PO Number"],
      order_description: description,
      unit_number: description?.match(UNIT_IN_DESCRIPTION)?.[1]?.toUpperCase() ?? null,
      contact_name: head["Contact Name"],
      contact_email: (head["E-Mail"] ?? head.Email)?.toLowerCase() ?? null,
      location_number: shipTo?.code ?? null,
      location_name: shipTo?.name ?? null,
      location_suffix: shipTo?.suffix ?? null,
      location_address: address,
      requested_date: dates[0] ?? null,
      cost_center: costCenters.join(", ") || null,
    }),
    items,
    warnings,
  };
}
