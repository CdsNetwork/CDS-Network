/**
 * Shop updates flag (Ashley, 2026-11-11, point 8): WO 101924 failed, the shop added notes and
 * photos about the failure, but CDS's list still only said "in process".
 *
 * A work order is "New from shop" when the shop added a shared note, uploaded a file, or
 * marked a filter or component failed since CDS last opened it; opening the work order as CDS
 * clears it. The CDS list marks those rows and can show only them, a failed or condemned
 * component shows right on the list row, and dispatch@ gets one email per failure.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { failedMark, isNewFromShop, FROM_SHOP_PARAM } from "@/components/cds-wo/shop-updates";
import { filterQuery, parseFilters } from "@/components/cds-wo/woFilters";
import {
  buildPortalEmail,
  notifyWorkOrderEvent,
  type PortalEmailDetails,
  type PortalEmailStore,
} from "@/lib/portal-email";

const WO = "22222222-2222-4222-8222-222222222222";
const COMPONENT = "33333333-3333-4333-8333-333333333333";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("failedMark", () => {
  it("shows Failed when any component failed, even if another was cleaned", () => {
    expect(failedMark([{ result: "cleaned" }, { result: "failed" }])).toBe("Failed");
    expect(failedMark([{ result: "condemned" }, { result: "failed" }])).toBe("Failed");
  });

  it("shows Condemned when the only bad result is condemned", () => {
    expect(failedMark([{ result: "condemned" }, { result: null }])).toBe("Condemned");
  });

  it("shows nothing for cleaned, passed, no result or no components", () => {
    expect(failedMark([{ result: "cleaned" }, { result: "passed" }, { result: null }])).toBeNull();
    expect(failedMark([])).toBeNull();
    expect(failedMark(null)).toBeNull();
    expect(failedMark(undefined)).toBeNull();
  });
});

describe("isNewFromShop", () => {
  it("reads the embedded activity row as an object or an array", () => {
    expect(isNewFromShop({ is_new: true })).toBe(true);
    expect(isNewFromShop([{ is_new: true }])).toBe(true);
    expect(isNewFromShop({ is_new: false })).toBe(false);
    expect(isNewFromShop([])).toBe(false);
    expect(isNewFromShop(null)).toBe(false);
  });
});

describe("New from shop filter", () => {
  it("is read from the query string and kept in links and the CSV export", () => {
    expect(FROM_SHOP_PARAM).toBe("from_shop");
    const f = parseFilters({ from_shop: "1", status: "in_progress" });
    expect(f.fromShop).toBe(true);
    expect(filterQuery(f)).toContain("from_shop=1");
    expect(parseFilters({}).fromShop).toBe(false);
    expect(parseFilters({ from_shop: "yes please" }).fromShop).toBe(false);
    expect(filterQuery(parseFilters({}))).not.toContain("from_shop");
  });
});

describe("CDS work order list", () => {
  const page = read("src/app/cds/page.tsx");

  it("loads the shop activity flag and the component results of each row", () => {
    expect(page).toMatch(/work_order_shop_activity\(is_new\)/);
    expect(page).toMatch(/work_order_components\(result\)/);
  });

  it("marks flagged rows New from shop, shows a failure on the row, and offers the filter", () => {
    expect(page).toContain("New from shop");
    expect(page).toMatch(/failedMark\(/);
    expect(page).toMatch(/name=\{?"from_shop"\}?/);
  });
});

describe("CDS work order page", () => {
  it("clears the flag when CDS opens the work order, from the browser so a link prefetch does not", () => {
    const page = read("src/app/cds/work-orders/[id]/page.tsx");
    expect(page).toMatch(/<MarkSeen\s+workOrderId=\{id\}/);
    const comp = read("src/components/cds-wo/MarkSeen.tsx");
    expect(comp).toMatch(/^"use client";/);
    expect(comp).toMatch(/useEffect/);
    const actions = read("src/app/cds/work-orders/[id]/actions.ts");
    expect(actions).toMatch(/cds_mark_work_order_seen/);
  });
});

describe("Shop saves a failed component", () => {
  it("emails dispatch@ about that component after the save", () => {
    const actions = read("src/app/shop/actions.ts");
    expect(actions).toMatch(/emailCdsAfter\("failed", workOrderId, componentId\)/);
  });
});

const details = (over: Partial<PortalEmailDetails> = {}): PortalEmailDetails => ({
  workOrderId: WO,
  woNumber: 101924,
  customer: "First Student, Inc",
  location: "FS 12723 Anaheim",
  unitNumber: "284113",
  poNumber: "7741200",
  shop: "Enviromotive",
  at: "2026-11-11T18:15:00Z",
  declineReason: null,
  shopReference: null,
  component: "DPF, part 2871891, serial SN-4471",
  result: "Failed",
  failureNote: "Cracked substrate, see photos",
  ...over,
});

describe("Failure email", () => {
  it("names the work order, the component and the shop in a [Portal] subject", () => {
    expect(buildPortalEmail("failed", details()).subject).toBe("[Portal] WO 101924 DPF marked Failed by Enviromotive");
    expect(buildPortalEmail("failed", details({ result: "Condemned", shop: null })).subject).toBe(
      "[Portal] WO 101924 DPF marked Condemned by a shop",
    );
  });

  it("has the customer, location, component, reason and a link to the work order", () => {
    const { text, html } = buildPortalEmail("failed", details({ failureNote: "Cracked <badly>" }));
    expect(text).toContain("A component on WO 101924 was marked Failed by Enviromotive.");
    expect(text).toContain("Customer: First Student, Inc");
    expect(text).toContain("Location: FS 12723 Anaheim");
    expect(text).toContain("Component: DPF, part 2871891, serial SN-4471");
    expect(text).toContain("Result: Failed");
    expect(text).toContain("Reason: Cracked <badly>");
    expect(text).toContain(`https://cds-network-portal.vercel.app/cds/work-orders/${WO}`);
    expect(html).toContain("Cracked &lt;badly&gt;");
    expect(`${text}${html}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("leaves the failure rows out of the other status emails", () => {
    const { text } = buildPortalEmail("sent", details());
    expect(text).not.toContain("Component:");
    expect(text).not.toContain("Reason:");
  });

  it("looks up the failure of the saved component and emails each failure once", async () => {
    const claimed = new Set<string>();
    const store: PortalEmailStore = {
      details: vi.fn(async () => ({ ...details(), key: "failed:f-1" })),
      claim: vi.fn(async (_e, _wo, key) => {
        if (claimed.has(key)) return null;
        claimed.add(key);
        return { rowId: claimed.size };
      }),
      finish: vi.fn(async () => {}),
    };
    const fetchImpl = vi.fn(async () => Response.json({ id: "re_1" })) as unknown as typeof fetch;
    const env = { PORTAL_EMAILS_ENABLED: "true", RESEND_SEND_API_KEY: "re_test" };
    const first = await notifyWorkOrderEvent("failed", WO, { store, env, fetchImpl, componentId: COMPONENT });
    const again = await notifyWorkOrderEvent("failed", WO, { store, env, fetchImpl, componentId: COMPONENT });
    expect(store.details).toHaveBeenCalledWith("failed", WO, COMPONENT);
    expect([first.status, again.status]).toEqual(["ok", "duplicate"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
