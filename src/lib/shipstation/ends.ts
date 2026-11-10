/**
 * Which end of each shipment leg is which, and what to tell CDS when an end has no address
 * yet. Pure: the label code and the work order page both use it.
 */

import { dispatchShopDefault, REVIEW_STATUSES } from "@/components/cds-wo/util";

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

/** Whether a leg goes to or from the shop, and which end the shop is. */
export function shopEnd(direction: string): "from" | "to" | null {
  const ends = ENDS[direction];
  if (!ends) return null;
  return ends[0] === "shop" ? "from" : ends[1] === "shop" ? "to" : null;
}

/** The shop a label's shop end is addressed to, and whether it is only planned. */
export type LabelShop = { affiliateId: string; planned: boolean };

/**
 * The shop rates and labels use for a leg to or from the shop. Once the order is dispatched
 * it is the order's shop. While the order is in review (CDS preps the label before
 * dispatching) it is the planned shop: the one Review & Dispatch offers by default
 * (dispatchShopDefault: the order's shop after Send back to review, else the location's
 * default shop, never the shop that declined). Null when there is none: CDS then has to
 * assign a shop first (NO_SHOP_PROBLEM).
 */
export function labelShop(wo: { status: string; affiliateId: string | null; locationDefault: string | null }): LabelShop | null {
  if (REVIEW_STATUSES.includes(wo.status)) {
    const planned = dispatchShopDefault(wo);
    return planned ? { affiliateId: planned, planned: true } : null;
  }
  return wo.affiliateId ? { affiliateId: wo.affiliateId, planned: false } : null;
}

/**
 * The warning for a label in use that was made for another shop than the one the order is
 * with now (dispatched or reassigned elsewhere after the label was made), or null. Labels
 * with no shop recorded (legs without a shop end, labels made before the shop was recorded)
 * never warn.
 */
export function labelShopMismatch(
  label: { shopId: string | null; shopName: string | null },
  now: { shop: LabelShop | null; shopName: string | null },
): string | null {
  if (!label.shopId) return null;
  if (now.shop?.affiliateId === label.shopId) return null;
  const made = label.shopName ?? "another shop";
  const tail = "Void it and make a new one.";
  if (!now.shop) return `The shipping label was made for ${made}, but no shop is picked for the order now. ${tail}`;
  const other = now.shopName ?? "another shop";
  return now.shop.planned
    ? `The shipping label was made for ${made}, but the planned shop is now ${other}. ${tail}`
    : `The shipping label was made for ${made}, but the order went to ${other}. ${tail}`;
}
