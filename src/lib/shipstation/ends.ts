/**
 * Which end of each shipment leg is which, and what to tell CDS when an end has no address
 * yet. Pure: the label code and the work order page both use it.
 */

export type LegEnd = "location" | "shop" | "cds";

/** Which end of each leg is which (see the 20261018000000 migration header). */
export const ENDS: Record<string, [from: LegEnd, to: LegEnd]> = {
  customer_to_affiliate: ["location", "shop"],
  affiliate_to_customer: ["shop", "location"],
  supplier_to_customer: ["shop", "location"],
  cds_to_customer: ["cds", "location"],
  customer_to_cds: ["location", "cds"],
};

export const NO_SHOP_PROBLEM = "Assign a shop to this work order first: this shipment goes to or from the shop";
export const NO_LOCATION_PROBLEM = "Set the customer location on this work order first: this shipment goes to or from the customer location";

/**
 * What is missing before rates or a label can be had for a leg: the shop or the customer
 * location the leg goes to or from. Empty when nothing is missing (or the direction has no label).
 */
export function missingLegEnds(direction: string, wo: { affiliateId: string | null; locationId: string | null }): string[] {
  const ends = ENDS[direction] ?? [];
  const problems: string[] = [];
  if (ends.includes("shop") && !wo.affiliateId) problems.push(NO_SHOP_PROBLEM);
  if (ends.includes("location") && !wo.locationId) problems.push(NO_LOCATION_PROBLEM);
  return problems;
}
