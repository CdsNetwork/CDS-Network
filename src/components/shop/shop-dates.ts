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

/**
 * When the part was back with the customer (Clyde, CDS, 2026-11-18): the carrier's delivery of
 * the return leg (shop to customer; the last one once every return leg is delivered), else when
 * the order became Delivered (work_orders.delivered_at, set by CDS or by tracking). Null before.
 */
export function returnedAt(job: { delivered_at: string | null }, legs: Leg[] | null | undefined): string | null {
  const back = (legs ?? []).filter((l) => l.direction === "affiliate_to_customer");
  if (back.length && back.every((l) => l.delivered_at)) {
    return back.map((l) => l.delivered_at as string).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  }
  return job.delivered_at ?? null;
}

export type TimelineStep = {
  label: "Dispatched" | "Accepted" | "Picked up" | "Received" | "Completed" | "Returned";
  at: string;
};

/**
 * The steps of a job that have happened, in order, for the shop's job page (Clyde, CDS,
 * 2026-11-18): Dispatched, Accepted, Picked up (pickup jobs) or Received (the part arrived),
 * Completed, Returned.
 */
export function shopTimeline(
  job: {
    fulfillment: string;
    dispatched_at: string | null;
    accepted_at: string | null;
    picked_up_at: string | null;
    completed_at: string | null;
    delivered_at: string | null;
  },
  legs: Leg[] | null | undefined,
): TimelineStep[] {
  const steps: { label: TimelineStep["label"]; at: string | null }[] = [
    { label: "Dispatched", at: job.dispatched_at },
    { label: "Accepted", at: job.accepted_at },
    job.fulfillment === "pickup"
      ? { label: "Picked up", at: job.picked_up_at }
      : { label: "Received", at: receivedAt(job, legs) },
    { label: "Completed", at: job.completed_at },
    { label: "Returned", at: returnedAt(job, legs) },
  ];
  return steps.filter((s): s is TimelineStep => Boolean(s.at));
}
