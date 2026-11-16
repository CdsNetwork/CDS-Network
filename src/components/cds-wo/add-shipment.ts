/**
 * Shipment legs on the work order page: a local pickup order has none (the shop picks up and
 * returns the part); shipping and supplier direct orders (Supplier → Customer) do.
 */
export function canAddShipment(fulfillment: string): boolean {
  return fulfillment !== "pickup";
}

/** Help under "Add shipment": rates and the label are made on the leg, once it exists. */
export function addShipmentHelp(legCount: number): string {
  return legCount > 0
    ? "Add a leg, then get rates and create its label in the leg above."
    : "Add a leg, then get rates and create its label.";
}
