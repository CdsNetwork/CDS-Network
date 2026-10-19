import { DIRECTION_LABEL, SHIPMENT_STATUS_LABEL } from "@/lib/format";

export const DIRECTIONS = Object.keys(DIRECTION_LABEL);
export const SHIPMENT_STATUSES = Object.keys(SHIPMENT_STATUS_LABEL);

/** A new shipment leg has no label yet. */
export const NEW_SHIPMENT_STATUS = "label_needed";

export const LABEL_STATUSES: { value: string; label: string }[] = [
  { value: "needed", label: "Needed" },
  { value: "ready", label: "Ready" },
  { value: "sent", label: "Label Sent" },
  { value: "printed", label: "Printed" },
  { value: "voided", label: "Voided" },
  { value: "error", label: "Label Error" },
];

export const PACKAGE_TYPES: { value: string; label: string }[] = [
  { value: "dpf_box", label: "DPF Box" },
  { value: "doc_scr_box", label: "DOC / SCR Box" },
  { value: "parts_box", label: "Parts Box" },
  { value: "custom", label: "Custom Package" },
];

export const SERVICE_LEVELS = ["UPS Ground", "UPS 2nd Day Air", "UPS Next Day Air", "FedEx Ground", "FedEx 2Day", "FedEx Express Saver", "Freight", "Other"];

export function labelStatusLabel(value: string): string {
  return LABEL_STATUSES.find((s) => s.value === value)?.label ?? value;
}
