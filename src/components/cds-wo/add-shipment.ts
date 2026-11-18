/**
 * Shipment legs on the work order page. Every order may get one, also a local pickup order
 * (Sarah, CDS, 2026-11-18: a local shop cleans a filter, it fails, and CDS ships the customer
 * a replacement). The Add shipment form stays collapsed until opened.
 */

/** What the Logistics box says while the order has no legs. */
export function noShipmentsNotice(fulfillment: string): string {
  return fulfillment === "pickup"
    ? "Affiliate Pickup / Local Delivery. The shop picks up and returns the part, so usually no shipment is needed. " +
        "If something must be shipped (for example a replacement for a failed part), add a shipment below."
    : "No shipment legs yet. Add one below when a tracking number is known.";
}

/** The direction the Add shipment form starts with. */
export function defaultShipmentDirection(fulfillment: string): string {
  if (fulfillment === "pickup") return "cds_to_customer";
  if (fulfillment === "supplier_direct") return "supplier_to_customer";
  return "customer_to_affiliate";
}

/** Help under "Add shipment": rates and the label are made on the leg, once it exists. */
export function addShipmentHelp(legCount: number): string {
  return legCount > 0
    ? "Add a leg, then get rates and create its label in the leg above."
    : "Add a leg, then get rates and create its label.";
}
