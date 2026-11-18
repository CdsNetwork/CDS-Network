import { voidLabelConfirm } from "@/components/shipping/confirm";

/**
 * How a shipment leg can be taken off the work order (Sarah, CDS, 2026-11-18):
 *   * "remove": no label in use. A tracking number typed by hand does not block it.
 *   * "void_and_remove": a label in use. One confirm voids the label (the usual void path),
 *     then removes the leg; when the void fails, nothing is removed.
 *   * null: the order is invoiced, so its shipments stay.
 * The database checks the same (public.cds_remove_shipment,
 * 20261119100000_remove_shipment_hand_tracking.sql).
 */
export type ShipmentRemoval = "remove" | "void_and_remove" | null;

export function shipmentRemoval(leg: { activeLabel: boolean; invoiced: boolean }): ShipmentRemoval {
  if (leg.invoiced) return null;
  return leg.activeLabel ? "void_and_remove" : "remove";
}

/** Confirm text for "Void label and remove": what voiding means, then that the leg goes. */
export function voidAndRemoveConfirm(label: { is_test: boolean; carrier: string | null; tracking_number: string | null }): string {
  return `${voidLabelConfirm(label)} Then this shipment is removed from the work order, with its notes and costs.`;
}
