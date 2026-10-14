export type WoStatus =
  | "pending_review"
  | "awaiting_acceptance"
  | "accepted"
  | "picked_up"
  | "in_process"
  | "completed"
  | "delivered"
  | "ready_to_invoice"
  | "invoiced"
  | "rejected_by_affiliate"
  | "cancelled";

export const STATUS_LABEL: Record<WoStatus, string> = {
  pending_review: "Pending Review",
  awaiting_acceptance: "Awaiting Affiliate Acceptance",
  accepted: "Accepted",
  picked_up: "Picked Up",
  in_process: "In Process",
  completed: "Completed",
  delivered: "Delivered",
  ready_to_invoice: "Ready to Invoice",
  invoiced: "Invoiced",
  rejected_by_affiliate: "Declined by Shop",
  cancelled: "Cancelled",
};

/** Shops see shorter labels (prototype v3). */
export const SHOP_STATUS_LABEL: Partial<Record<WoStatus, string>> = {
  awaiting_acceptance: "Awaiting Acceptance",
  completed: "Complete",
  delivered: "Complete",
  ready_to_invoice: "Complete",
  invoiced: "Complete",
};

export const STATUS_ORDER: WoStatus[] = [
  "pending_review",
  "awaiting_acceptance",
  "accepted",
  "picked_up",
  "in_process",
  "completed",
  "delivered",
  "ready_to_invoice",
  "invoiced",
  "cancelled",
];

export const FULFILLMENT_LABEL: Record<string, string> = {
  pickup: "Affiliate Pickup / Local Delivery",
  shipping: "Shipping / Carrier",
  supplier_direct: "Supplier Direct Ship",
  unspecified: "Not set",
};

export const PICKUP_WINDOWS: { value: string; label: string }[] = [
  { value: "08-10", label: "8:00 AM - 10:00 AM" },
  { value: "10-12", label: "10:00 AM - 12:00 PM" },
  { value: "12-14", label: "12:00 PM - 2:00 PM" },
  { value: "14-16", label: "2:00 PM - 4:00 PM" },
  { value: "16-17", label: "4:00 PM - 5:00 PM" },
  { value: "coordinate", label: "Need to coordinate" },
];

export function pickupWindowLabel(value: string | null | undefined): string {
  return PICKUP_WINDOWS.find((w) => w.value === value)?.label ?? "Not accepted yet";
}

export const SHIP_STATUS_LABEL: Record<string, string> = {
  awaiting_delivery: "Awaiting Delivery",
  received: "Received",
  in_process: "In Process",
  ready_to_ship: "Ready to Ship",
  shipped: "Shipped",
};

export const COMPONENT_RESULT_LABEL: Record<string, string> = {
  cleaned: "Cleaned Successfully",
  passed: "Pass",
  failed: "Failed",
  condemned: "Condemned",
};

export const CATEGORY_LABEL: Record<string, string> = {
  service: "Service",
  gasket: "Gasket",
  bung: "Bung",
  clamp: "Clamp",
  part: "Part",
};

export const ATTACHMENT_CATEGORY_LABEL: Record<string, string> = {
  condition_damage: "Condition / Damage",
  part_id_tag: "Part Number / ID Tag",
  shipping_damage: "Shipping Damage",
  completed_work: "Completed Work",
  other: "Other",
};

export const DIRECTION_LABEL: Record<string, string> = {
  customer_to_affiliate: "Customer → Affiliate",
  affiliate_to_customer: "Affiliate → Customer",
  cds_to_customer: "CDS → Customer",
  customer_to_cds: "Customer → CDS",
  supplier_to_customer: "Supplier → Customer",
};

export const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  label_created: "Label Created",
  awaiting_pickup: "Awaiting Carrier Pickup",
  picked_up: "Picked Up",
  in_transit: "In Transit",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  delayed: "Delayed",
  exception: "Carrier Exception",
  address_problem: "Address Problem",
  no_scan: "No Scan",
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function money(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return usd.format(Number(value));
}

export function woLabel(n: number | string): string {
  return `WO-${n}`;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export function date(value: string | null | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "-";
}
