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
  // Read from the request templates (and XPO's meter): shop-facing on the order.
  p_vin: string | null;
  p_mileage: number | null;
  p_requested_date: string | null;
  p_return_to_location: boolean;
  // CDS-only (work_order_internal): the customer's own order type, region and contact.
  p_order_type: string | null;
  p_customer_region: string | null;
  p_contact_name: string | null;
  p_contact_email: string | null;
  p_contact_phone: string | null;
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
    parsed.template ? `Read from the ${parsed.template.replace(/_/g, " ")} template.` : null,
    f.vin.value ? `VIN: ${f.vin.value}.` : null,
    f.serial_number?.value ? `Serial #: ${f.serial_number.value}.` : null,
    f.manufacturer?.value ? `Manufacturer: ${f.manufacturer.value}.` : null,
    f.part_number?.value ? `Part #: ${f.part_number.value}.` : null,
    f.order_description?.value ? `Order description: ${f.order_description.value}.` : null,
    f.cost_center?.value ? `Cost center: ${f.cost_center.value}.` : null,
    f.location_suffix?.value ? `Location suffix: ${f.location_suffix.value}.` : null,
    f.store_room?.value ? `Store room #: ${f.store_room.value}.` : null,
    f.pickup_option?.value ? `Pickup option: ${f.pickup_option.value}.` : null,
    f.filter_options?.value || f.parts_or_service?.value
      ? `Form: ${[f.filter_options?.value, f.parts_or_service?.value].filter(Boolean).join(", ")}.`
      : null,
    parsed.items.some((i) => i.price !== undefined && i.price !== null)
      ? `PO prices: ${parsed.items
          .filter((i) => i.price !== undefined && i.price !== null)
          .map((i) => `${i.sku ?? i.part_number ?? i.description} ${i.price!.toFixed(2)}`)
          .join(", ")}.`
      : null,
    !parsed.location && (f.location_number.value || f.location_address.value || f.location_name.value)
      ? `Location in email: ${[f.location_number.value, f.location_name.value, f.location_address.value].filter(Boolean).join(", ")}.`
      : null,
    unmatched.length
      ? `Not matched to the catalog: ${unmatched.map((i) => `${i.qty} x ${i.part_number ? `${i.part_number} ` : ""}${i.description}`).join("; ")}.`
      : null,
    f.notes.value ? `${parsed.template ? "Customer comments" : "Notes"}: ${f.notes.value}` : null,
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
      p_vin: f.vin.value ? cut(f.vin.value, 30) : null,
      p_mileage: f.mileage?.value ?? null,
      p_requested_date: f.requested_date?.value ?? null,
      p_return_to_location: f.return_to_location?.value === true || parsed.items.some((i) => i.return_to_location),
      p_order_type: f.order_type?.value ? cut(f.order_type.value, 100) : null,
      p_customer_region: f.region?.value ? cut(f.region.value, 100) : null,
      p_contact_name: f.contact_name?.value ? cut(f.contact_name.value, 200) : null,
      p_contact_email: f.contact_email?.value ? cut(f.contact_email.value, 320) : null,
      p_contact_phone: f.contact_phone?.value ? cut(f.contact_phone.value, 50) : null,
    },
  };
}
