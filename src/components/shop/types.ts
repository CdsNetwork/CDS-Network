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
  customer_name: string;
};

export type JobRow = {
  id: string;
  wo_number: number;
  status: WoStatus;
  market: string;
  fulfillment: "pickup" | "shipping" | "supplier_direct" | "unspecified";
  location_label: string;
  site_address: string | null;
  unit_number: string;
  po_number: string | null;
  requested_work: string;
  pickup_window: string | null;
  shop_ship_status: string | null;
  affiliate_invoice_ref: string | null;
  completed_at: string | null;
  customer_name: string;
};

export type LineRow = {
  id: string;
  qty: number;
  shop_unit_rate: number | null;
  origin: "cds_order" | "shop_added" | "auth_request";
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
  result: "cleaned" | "passed" | "failed" | "condemned" | null;
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
  url: string | null;
};

export type ShipmentRow = {
  id: string;
  direction: string;
  carrier: string | null;
  tracking_number: string | null;
  status: string;
};

/** An option for a select: id plus the text shown. */
export type Option = { id: string; label: string };

export function componentLabel(c: Pick<ComponentRow, "component_type" | "seq">): string {
  return `${c.component_type} #${c.seq}`;
}
