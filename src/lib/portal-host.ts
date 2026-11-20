/**
 * The portal's address (CDS, 2026-11-21: platform.cds.direct, DNS at GoDaddy, A record to
 * Vercel). The old Vercel address keeps answering: browser pages there redirect to the same
 * page on the new address, while webhooks (ShipStation, email intake), crons, sign-in links
 * from older emails (/auth/) and the QuickBooks routes stay where they are, so nothing that
 * is registered with an outside service has to change.
 */
export const PORTAL_HOST = "platform.cds.direct";
export const LEGACY_HOST = "cds-network-portal.vercel.app";

const KEEP_ON_LEGACY = ["/api/", "/auth/", "/quickbooks/", "/_next/"];

/** The new address for a browser page asked on the old one, or null to serve it as is. */
export function legacyRedirect(host: string | null, method: string, pathname: string, search: string): string | null {
  if (!host || host.toLowerCase() !== LEGACY_HOST) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  if (KEEP_ON_LEGACY.some((p) => pathname.startsWith(p))) return null;
  return `https://${PORTAL_HOST}${pathname}${search}`;
}
