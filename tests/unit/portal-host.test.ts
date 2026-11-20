import { describe, expect, it } from "vitest";
import { legacyRedirect, PORTAL_HOST } from "@/lib/portal-host";
import { PORTAL_BASE_URL } from "@/lib/portal-email";

// CDS, 2026-11-21: the portal moves to platform.cds.direct. Pages on the old Vercel address
// redirect there; webhooks, crons, sign-in links and the QuickBooks routes keep working on it.
describe("portal address", () => {
  it("links in emails use platform.cds.direct", () => {
    expect(PORTAL_HOST).toBe("platform.cds.direct");
    expect(PORTAL_BASE_URL).toBe("https://platform.cds.direct");
  });

  it("sends pages on the old address to the same page on the new one", () => {
    expect(legacyRedirect("cds-network-portal.vercel.app", "GET", "/cds", "")).toBe("https://platform.cds.direct/cds");
    expect(legacyRedirect("cds-network-portal.vercel.app", "GET", "/shop", "?job=1")).toBe("https://platform.cds.direct/shop?job=1");
    expect(legacyRedirect("cds-network-portal.vercel.app", "HEAD", "/login", "")).toBe("https://platform.cds.direct/login");
  });

  it("leaves webhooks, crons, sign-in links, QuickBooks routes and posts on the old address alone", () => {
    for (const path of ["/api/shipstation/webhook", "/api/intake/resend", "/api/cron/shop-emails", "/auth/confirm", "/quickbooks/connect"]) {
      expect(legacyRedirect("cds-network-portal.vercel.app", "GET", path, "")).toBeNull();
    }
    expect(legacyRedirect("cds-network-portal.vercel.app", "POST", "/cds", "")).toBeNull();
  });

  it("does nothing on the new address, previews or local", () => {
    expect(legacyRedirect("platform.cds.direct", "GET", "/cds", "")).toBeNull();
    expect(legacyRedirect("cds-network-portal-abc123-cds-network.vercel.app", "GET", "/cds", "")).toBeNull();
    expect(legacyRedirect("localhost:3000", "GET", "/cds", "")).toBeNull();
    expect(legacyRedirect(null, "GET", "/cds", "")).toBeNull();
  });
});
