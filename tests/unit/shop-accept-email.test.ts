/**
 * Shop accepts a job (CDS, 2026-11-11): the order gets the "New from shop" mark and dispatch@
 * gets an email with the WO number, shop, customer, site, unit and the pickup ETA / window the
 * shop chose. An email failure never breaks the accept.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildPortalEmail, notifyWorkOrderEvent, type PortalEmailDetails, type PortalEmailStore } from "@/lib/portal-email";
import { acceptedEta, PORTAL_EVENT_TYPE } from "@/lib/portal-email-store";

const WO = "22222222-2222-4222-8222-222222222222";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const details = (over: Partial<PortalEmailDetails> = {}): PortalEmailDetails => ({
  workOrderId: WO,
  woNumber: 101930,
  customer: "Ryder",
  location: "Ryder 0412 Fontana",
  unitNumber: "559102",
  poNumber: "PO-88",
  shop: "Enviromotive",
  at: "2026-11-11T18:15:00Z",
  declineReason: null,
  shopReference: null,
  eta: "10:00 AM - 12:00 PM",
  ...over,
});

describe("acceptedEta", () => {
  it("gives the pickup window label, and nothing on a shipping job", () => {
    expect(acceptedEta("10-12")).toBe("10:00 AM - 12:00 PM");
    expect(acceptedEta("coordinate")).toBe("Need to coordinate");
    expect(acceptedEta(null)).toBeNull();
    expect(acceptedEta(undefined)).toBeNull();
  });

  it("keys the acceptance on the shop's accept event", () => {
    expect(PORTAL_EVENT_TYPE.accepted).toBe("accept");
  });
});

describe("Acceptance email", () => {
  it("names the work order, the shop and the ETA in a [Portal] subject", () => {
    expect(buildPortalEmail("accepted", details()).subject).toBe("[Portal] WO 101930 accepted by Enviromotive, ETA 10:00 AM - 12:00 PM");
    expect(buildPortalEmail("accepted", details({ eta: null })).subject).toBe("[Portal] WO 101930 accepted by Enviromotive");
  });

  it("has the customer, site, unit, shop, ETA and a link to the work order", () => {
    const { text, html } = buildPortalEmail("accepted", details());
    expect(text).toContain("WO 101930 was accepted by Enviromotive.");
    expect(text).toContain("Customer: Ryder");
    expect(text).toContain("Location: Ryder 0412 Fontana");
    expect(text).toContain("Unit: 559102");
    expect(text).toContain("Shop: Enviromotive");
    expect(text).toContain("Pickup ETA / Window: 10:00 AM - 12:00 PM");
    expect(text).toContain(`https://cds-network-portal.vercel.app/cds/work-orders/${WO}`);
    expect(html).toContain("Pickup ETA / Window");
    expect(`${text}${html}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("leaves the ETA out of the other status emails", () => {
    expect(buildPortalEmail("sent", details()).text).not.toContain("ETA");
    expect(buildPortalEmail("sent", details()).subject).not.toContain("ETA");
  });

  it("emails one acceptance once, and a Resend failure is recorded, not thrown", async () => {
    const claimed = new Set<string>();
    const store: PortalEmailStore = {
      details: vi.fn(async () => ({ ...details(), key: "accepted:shop:7" })),
      claim: vi.fn(async (_e, _wo, key) => {
        if (claimed.has(key)) return null;
        claimed.add(key);
        return { rowId: claimed.size };
      }),
      finish: vi.fn(async () => {}),
    };
    const env = { PORTAL_EMAILS_ENABLED: "true", RESEND_SEND_API_KEY: "re_test" };
    const failing = vi.fn(async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    const first = await notifyWorkOrderEvent("accepted", WO, { store, env, fetchImpl: failing });
    expect(first.status).toBe("error");
    expect(store.finish).toHaveBeenCalledWith(1, "error", expect.stringMatching(/HTTP 500/));
    const again = await notifyWorkOrderEvent("accepted", WO, { store, env, fetchImpl: failing });
    expect(again.status).toBe("duplicate");
  });
});

describe("Shop accepts a job", () => {
  it("emails dispatch@ after a successful accept only, without waiting on the email", () => {
    const actions = read("src/app/shop/actions.ts");
    expect(actions).toMatch(/p_pickup_window: window \|\| null,\s*\}\);[\s\S]*?if \(!error\) emailCdsAfter\("accepted", workOrderId\);\s*return done\(error\);/);
    const send = read("src/lib/portal-email-send.ts");
    expect(send).toMatch(/after\(async \(\) => \{\s*try \{/);
  });

  it("marks the order New from shop on accept and on a shop ETA change", () => {
    const sql = read("supabase/migrations/20261111080000_shop_accept_activity.sql");
    expect(sql).toMatch(/check \(shop_activity in \('note', 'file', 'failed', 'accepted', 'eta'\)\)/);
    expect(sql).toMatch(/private\.is_shop_login\(auth\.uid\(\)\)/);
    expect(sql).toMatch(/record_shop_activity\(new\.id, 'accepted'\)/);
    expect(sql).toMatch(/record_shop_activity\(new\.id, 'eta'\)/);
    expect(sql).toMatch(/after update of status, pickup_window on public\.work_orders/);
    expect(sql).not.toMatch(/[\u2013\u2014]/);
  });
});
