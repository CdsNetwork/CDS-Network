/**
 * Which shipment legs the CDS Shipping queue lists however old they are: every leg that is
 * not finished, and every leg whose label is needed or failed.
 */

/**
 * Shipment statuses that end a leg. Every other status (label needed or created, awaiting
 * pickup, picked up, in transit, out for delivery, delayed, carrier exception, address
 * problem, no scan) still needs CDS to watch or act, so the leg stays listed.
 */
export const FINISHED_SHIPMENT_STATUSES = ["delivered"] as const;

type QueueLeg = { label_status: string; status: string };

/** PostgREST `or` filter for legs that still need attention. */
export function openShipmentFilter(openLabel: readonly string[]): string {
  return `label_status.in.(${openLabel.join(",")}),status.not.in.(${FINISHED_SHIPMENT_STATUSES.join(",")})`;
}

/** The same rule as openShipmentFilter, for one leg. */
export function isOpenShipment(s: QueueLeg, openLabel: readonly string[]): boolean {
  return openLabel.includes(s.label_status) || !(FINISHED_SHIPMENT_STATUSES as readonly string[]).includes(s.status);
}

/** Open legs plus the newest legs, each once, newest first. */
export function mergeShipmentQueue<T extends { id: string; created_at: string }>(open: T[], recent: T[]): T[] {
  const byId = new Map<string, T>();
  for (const s of [...open, ...recent]) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}
