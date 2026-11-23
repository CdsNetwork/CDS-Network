import type { WoStatus } from "@/lib/format";

/** Result of every shop server action. `ok` changes on each success so forms can reset. */
export type ActionState = { error?: string; ok?: number };

export type QueueTab = "awaiting" | "active" | "completed";

export const TAB_STATUSES: Record<QueueTab, WoStatus[]> = {
  awaiting: ["awaiting_acceptance"],
  active: ["accepted", "picked_up", "in_process"],
  completed: ["completed", "delivered", "ready_to_invoice", "invoiced", "cancelled"],
};

export const EDITABLE_STATUSES: WoStatus[] = ["accepted", "picked_up", "in_process"];

/**
 * A parts-only order is a parts sale at any shop: it completes without components,
 * measurements or photos (20261119090000_parts_only_no_measurements.sql).
 */
export function isPartsSale(requestType: string): boolean {
  return requestType === "parts_only";
}

/** What a status change sends back in the URL (?done=), so the outcome is still shown after the page re-renders. */
export type DoneKey = "accepted" | "picked_up" | "in_process" | "completed";

const DONE_TEXT: Record<DoneKey, string> = {
  accepted: "Job accepted. CDS was notified.",
  picked_up: "Marked picked up.",
  in_process: "Marked in process.",
  completed: "Job completed. CDS was notified.",
};

/** The confirmation for ?done=, or null when the value is unknown or no longer matches the job. */
export function doneNotice(done: string | undefined, status: WoStatus): string | null {
  if (!done || !Object.hasOwn(DONE_TEXT, done) || status === "awaiting_acceptance") return null;
  if (done === "completed" && EDITABLE_STATUSES.includes(status)) return null;
  return DONE_TEXT[done as DoneKey];
}

export function tabForStatus(status: WoStatus): QueueTab {
  if (TAB_STATUSES.awaiting.includes(status)) return "awaiting";
  if (TAB_STATUSES.active.includes(status)) return "active";
  return "completed";
}

export type QueueJob = {
  id: string;
  wo_number: number;
  status: WoStatus;
  location_label: string;
  requested_work: string;
  unit_number: string;
  po_number: string | null;
  /** The customer's part number (Part #), when CDS or the email gave one. */
  customer_part_number: string | null;
  /** The manufacturer the customer's request named, when CDS or the email gave one. */
  customer_manufacturer: string | null;
  customer_name: string;
  /** When CDS dispatched the order to this shop. */
  dispatched_at: string | null;
  /** When the shop received the part (shop-dates receivedAt), or null. */
  received_at: string | null;
  completed_at: string | null;
};

export type JobRow = {
  id: string;
  wo_number: number;
  status: WoStatus;
  market: string;
  fulfillment: "pickup" | "shipping" | "supplier_direct" | "unspecified";
  location_label: string;
  site_address: string | null;
  unit_number: string | null;
  po_number: string | null;
  customer_part_number: string | null;
  customer_manufacturer: string | null;
  requested_work: string;
  pickup_window: string | null;
  /** The day the shop picks the part up (pickup jobs; null on orders accepted before 2026-11-19). */
  pickup_date: string | null;
  shop_ship_status: string | null;
  affiliate_invoice_ref: string | null;
  dispatched_at: string | null;
  accepted_at: string | null;
  picked_up_at: string | null;
  completed_at: string | null;
  delivered_at: string | null;
  customer_name: string;
};

export type LineRow = {
  id: string;
  qty: number;
  shop_unit_rate: number | null;
  origin: "cds_order" | "shop_added" | "auth_request";
  /** Text CDS entered on the line (Misc. hardware). */
  description: string | null;
  sku: string;
  name: string;
};

export type ComponentType = "DPF" | "DOC" | "SCR" | "EGR";

export type ComponentRow = {
  id: string;
  seq: number;
  component_type: ComponentType;
  manufacturer: string | null;
  part_number: string | null;
  serial_number: string | null;
  dp_before: number | null;
  dp_after: number | null;
  weight_before_g: number | null;
  weight_after_g: number | null;
  result: "cleaned" | "passed" | "condemned" | null;
  result_note: string | null;
};

export type AuthRequestRow = {
  id: string;
  seq: number;
  kind: "service" | "part";
  qty: number;
  note: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  requested_at: string;
  sku: string;
  name: string;
};

export type AttachmentView = {
  id: string;
  component_id: string | null;
  category: string;
  file_name: string;
  mime_type: string | null;
  note: string | null;
  uploaded_at: string;
  /** Added by CDS staff (CDS files carry no shop stamp; shop files always do). */
  from_cds: boolean;
  /** The shop may remove it: its own upload, before the job is completed (shopCanRemove). */
  can_remove: boolean;
  url: string | null;
};

export type ShipmentRow = {
  id: string;
  direction: string;
  carrier: string | null;
  tracking_number: string | null;
  status: string;
  /** The CDS label for this leg (never its cost). */
  label: { id: string; service_name: string | null; tracking_number: string | null; is_test: boolean } | null;
};

/** An option for a select: id plus the text shown. */
export type Option = { id: string; label: string };

/**
 * A catalog item for a search picker. Only shop-safe text: "SKU - name", category, the
 * shop's own pay rate (parts) and the OE cross reference as search words. Never customer
 * prices, margins or CDS notes.
 */
export type CatalogOption = Option & { category: string; hint: string; keywords?: string };

/**
 * Whether a component's pressure and weight are required: a DPF is measured, unless the shop
 * condemned it (a condemned filter is not measured). DOC and SCR measurements are optional
 * (Sarah, CDS, 2026-11-17); an EGR cooler has none.
 */
export function measurementsRequired(type: ComponentType, result: string | null): boolean {
  return type === "DPF" && result !== "condemned";
}

/**
 * Whether a condemned component needs a damage photo before the job completes: yes, except
 * an EGR cooler (Sarah, CDS, 2026-11-17). Same rule as public.shop_complete_work_order.
 */
export function condemnedPhotoRequired(type: ComponentType, result: string | null): boolean {
  return result === "condemned" && type !== "EGR";
}

export function componentLabel(c: Pick<ComponentRow, "component_type" | "seq">): string {
  return `${c.component_type} #${c.seq}`;
}
