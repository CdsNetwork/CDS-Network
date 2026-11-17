/**
 * Shipment carrier status in the CDS work order list (Sarah, CDS, 2026-11-17): each shipment
 * leg of the order with a short direction and its status, which CDS changes in the row with
 * the Shipping page's action (setShipmentStatus). Safe on server and client.
 */
import { DIRECTION_LABEL } from "@/lib/format";
import { upsTrackingUrl } from "@/lib/shipstation/requests";

/** A shipment leg as embedded in the list query (LEG_COLUMNS). */
export type LegRow = {
  id: string;
  direction: string;
  status: string;
  carrier: string | null;
  tracking_number: string | null;
  created_at: string;
};

export const LEG_COLUMNS = "shipments(id, direction, status, carrier, tracking_number, created_at)";

export type ListLeg = {
  id: string;
  /** "In": to the shop or CDS. "Out": back to the customer (private.is_return_leg). */
  dir: "In" | "Out";
  status: string;
  /** The tracking number, shown in the row next to In or Out; null when there is none. */
  tracking: string | null;
  /** Full direction, carrier and tracking number, for the tooltip. */
  title: string;
  /** UPS's tracking page for a UPS tracking number; null otherwise. */
  trackingUrl: string | null;
};

/** Legs that end at the customer's location, as private.is_return_leg in the database. */
const RETURN_DIRECTIONS = ["affiliate_to_customer", "cds_to_customer", "supplier_to_customer"];

/** The order's legs for the list: In legs first, then Out legs, oldest first in each. */
export function listLegs(rows: LegRow[] | null | undefined): ListLeg[] {
  return [...(rows ?? [])]
    .map((r) => ({ r, dir: RETURN_DIRECTIONS.includes(r.direction) ? ("Out" as const) : ("In" as const) }))
    .sort((a, b) => (a.dir === b.dir ? a.r.created_at.localeCompare(b.r.created_at) || a.r.id.localeCompare(b.r.id) : a.dir === "In" ? -1 : 1))
    .map(({ r, dir }) => {
      const tracking = r.tracking_number?.trim() || null;
      const parts = [r.carrier, tracking].filter(Boolean).join(" ");
      return {
        id: r.id,
        dir,
        status: r.status,
        tracking,
        title: `${DIRECTION_LABEL[r.direction] ?? r.direction}${parts ? `, ${parts}` : ""}`,
        trackingUrl: r.carrier === "UPS" && tracking ? upsTrackingUrl(tracking) : null,
      };
    });
}
