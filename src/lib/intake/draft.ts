/**
 * Turns a parsed email into the arguments of intake_create_draft_work_order. The order is
 * always created in Pending Review: CDS checks it and dispatches it by hand.
 */
import type { NormalizedEmail, ParsedEmail } from "./types";

export type DraftParams = {
  p_email: string;
  p_customer: string;
  p_location: string | null;
  p_location_label: string | null;
  p_site_address: string | null;
  p_request_type: "service" | "parts_only";
  p_fulfillment: "pickup" | "shipping" | "unspecified";
  p_unit_number: string | null;
  p_po_number: string | null;
  p_requested_work: string;
  p_internal_notes: string;
  p_review_reason: string;
  p_lines: { catalog_item_id: string; qty: number }[];
};

export type DraftDecision = { ok: true; params: DraftParams } | { ok: false; reason: string };

const cut = (v: string, max: number) => (v.length > max ? `${v.slice(0, max - 3)}...` : v);

export function buildDraftParams(emailId: string, email: NormalizedEmail, parsed: ParsedEmail): DraftDecision {
  if (!parsed.is_work_request) return { ok: false, reason: parsed.ignore_reason ?? "Not a work request" };
  if (!parsed.customer) return { ok: false, reason: "Customer not recognised: create the order by hand or add the sender domain." };

  // One line per catalog item; the same item read twice keeps the larger quantity.
  const lines = new Map<string, number>();
  for (const item of parsed.items) {
    if (!item.catalog_item_id) continue;
    lines.set(item.catalog_item_id, Math.max(lines.get(item.catalog_item_id) ?? 0, item.qty));
  }

  const missing: string[] = [];
  if (!parsed.location) missing.push("location");
  if (!parsed.fields.unit_number.value) missing.push("unit number");
  if (!parsed.fields.po_number.value) missing.push("PO number");
  if (!lines.size) missing.push("services or parts");
  const reason = [
    `From email (${parsed.confidence_label} confidence): check before dispatch`,
    missing.length ? `missing ${missing.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  const unmatched = parsed.items.filter((i) => !i.catalog_item_id);
  const f = parsed.fields;
  const notes = [
    `Created from an email to dispatch. From: ${email.from}. Subject: ${email.subject || "(none)"}. Received: ${email.receivedAt}.`,
    `Confidence ${Math.round(parsed.confidence * 100)}% (${parsed.confidence_label})${parsed.llm.used ? "" : ", pattern matching only"}.`,
    f.vin.value ? `VIN: ${f.vin.value}.` : null,
    !parsed.location && (f.location_number.value || f.location_address.value || f.location_name.value)
      ? `Location in email: ${[f.location_number.value, f.location_name.value, f.location_address.value].filter(Boolean).join(", ")}.`
      : null,
    unmatched.length
      ? `Not matched to the catalog: ${unmatched.map((i) => `${i.qty} x ${i.part_number ? `${i.part_number} ` : ""}${i.description}`).join("; ")}.`
      : null,
    f.notes.value ? `Notes: ${f.notes.value}` : null,
    parsed.warnings.length ? `Check: ${parsed.warnings.join(" ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const label = parsed.location
    ? null
    : [f.location_number.value, f.location_name.value].filter(Boolean).join(" ") || f.location_address.value || null;

  return {
    ok: true,
    params: {
      p_email: emailId,
      p_customer: parsed.customer.id,
      p_location: parsed.location?.id ?? null,
      p_location_label: label ? cut(label, 200) : null,
      p_site_address: parsed.location ? null : f.location_address.value ? cut(f.location_address.value, 500) : null,
      p_request_type: parsed.request_type,
      p_fulfillment: f.fulfillment.value ?? "unspecified",
      p_unit_number: f.unit_number.value ? cut(f.unit_number.value, 100) : null,
      p_po_number: f.po_number.value ? cut(f.po_number.value, 100) : null,
      p_requested_work: cut(f.requested_work.value || email.subject || "See the email", 2000),
      p_internal_notes: cut(notes, 2000),
      p_review_reason: cut(reason, 500),
      p_lines: [...lines].map(([catalog_item_id, qty]) => ({ catalog_item_id, qty })),
    },
  };
}
