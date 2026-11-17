/**
 * Shop job dates and label rules (Sarah, CDS, 2026-11-17). Safe on server and client.
 */

type Leg = { direction: string; delivered_at: string | null };

/**
 * When the shop received the part: the carrier's delivery time of the inbound leg (customer
 * to shop; the earliest when there are several), else when the shop marked a pickup job
 * Picked Up. Null while the part has not arrived.
 */
export function receivedAt(job: { picked_up_at: string | null }, legs: Leg[] | null | undefined): string | null {
  const delivered = (legs ?? [])
    .filter((l) => l.direction === "customer_to_affiliate" && l.delivered_at)
    .map((l) => l.delivered_at as string)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return delivered[0] ?? job.picked_up_at ?? null;
}

/**
 * Whether a shop sees and prints the label of a shipment leg: only the leg from the shop back
 * to the customer. Same rule as the shipment_labels shop_read policy
 * (20261119020000_shop_labels_outbound_only.sql).
 */
export function shopCanSeeLabel(direction: string): boolean {
  return direction === "affiliate_to_customer";
}
