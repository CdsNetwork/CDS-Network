/**
 * Clyde, CDS, 2026-11-18 (shop side):
 *  A) Dates on the shop job list and job page: the date the order was dispatched to the shop
 *     under the WO number on the list; on the job page every step that happened (Dispatched,
 *     Accepted, Picked up or Received, Completed, Returned), Pacific dates.
 *  B) Shop calendar: a shop accepting a pickup job chooses the pickup day (default today
 *     Pacific, never in the past) plus the window, and may change both until the part is picked
 *     up. The calendar shows pickup jobs on their pickup day with the window, and shipped jobs on
 *     the day the filters arrived at the shop. Jobs without a date are not on it.
 * The database rules are in tests/rls/shop-pickup-date.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { returnedAt, shopTimeline } from "@/components/shop/shop-dates";
import {
  calendarEntries,
  monthLabel,
  monthRange,
  monthWeeks,
  parseMonth,
  shiftMonth,
  type CalendarJob,
} from "@/components/shop/calendar";
import { pacificToday } from "@/lib/dates";
import { pickupChoiceError, pickupEtaLabel, SHOP_PICKUP_WINDOWS, weekdayOf } from "@/lib/pickup";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireShop: vi.fn(async () => ({ id: "s1", kind: "shop" })) }));
vi.mock("@/lib/portal-email-send", () => ({ emailCdsAfter: vi.fn() }));
vi.mock("@/lib/qbo/bill-server", () => ({ createShopBillAfter: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
const supabase = {
  rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => (rpcs.push({ fn, args }), { error: null })),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { acceptJob, changePickup } = await import("@/app/shop/actions");
const { acceptedEta } = await import("@/lib/portal-email-store");

const WO = "11111111-1111-4111-8111-111111111111";
/** A Pacific date a few days from now (the action refuses past days and days over a year out). */
const soon = (days: number) => pacificToday(new Date(Date.now() + days * 86_400_000));
const src = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  rpcs.length = 0;
});

// ------------------------------------------------------------------ A: dates

describe("shop job timeline", () => {
  const base = {
    fulfillment: "shipping",
    dispatched_at: "2026-11-02T17:00:00Z",
    accepted_at: "2026-11-03T01:30:00Z", // 2026-11-02 in California
    picked_up_at: null,
    completed_at: null,
    delivered_at: null,
  };

  it("lists only the steps that happened, in order, for a shipped job", () => {
    expect(shopTimeline(base, [])).toEqual([
      { label: "Dispatched", at: "2026-11-02T17:00:00Z" },
      { label: "Accepted", at: "2026-11-03T01:30:00Z" },
    ]);
    const legs = [
      { direction: "customer_to_affiliate", delivered_at: "2026-11-05T18:00:00Z" },
      { direction: "affiliate_to_customer", delivered_at: "2026-11-10T19:00:00Z" },
    ];
    expect(shopTimeline({ ...base, completed_at: "2026-11-07T20:00:00Z" }, legs).map((s) => s.label)).toEqual([
      "Dispatched",
      "Accepted",
      "Received",
      "Completed",
      "Returned",
    ]);
  });

  it("says Picked up on a pickup job", () => {
    const steps = shopTimeline({ ...base, fulfillment: "pickup", picked_up_at: "2026-11-04T16:00:00Z" }, []);
    expect(steps.map((s) => s.label)).toEqual(["Dispatched", "Accepted", "Picked up"]);
    expect(steps[2].at).toBe("2026-11-04T16:00:00Z");
  });

  it("Returned is the return leg's delivery, else when the order became delivered", () => {
    const back = (at: string | null) => ({ direction: "affiliate_to_customer", delivered_at: at });
    expect(returnedAt({ delivered_at: null }, [back("2026-11-10T19:00:00Z"), back("2026-11-11T19:00:00Z")])).toBe(
      "2026-11-11T19:00:00Z",
    );
    // A return leg still on its way: not returned yet, unless CDS marked the order delivered.
    expect(returnedAt({ delivered_at: null }, [back("2026-11-10T19:00:00Z"), back(null)])).toBeNull();
    expect(returnedAt({ delivered_at: "2026-11-12T22:00:00Z" }, [back(null)])).toBe("2026-11-12T22:00:00Z");
    expect(returnedAt({ delivered_at: "2026-11-12T22:00:00Z" }, [])).toBe("2026-11-12T22:00:00Z");
    expect(returnedAt({ delivered_at: null }, null)).toBeNull();
  });

  it("the list shows the dispatch date under the WO number and the job page shows the steps", () => {
    const queue = src("src/components/shop/JobQueue.tsx");
    expect(queue).toMatch(/woLabel\(j\.wo_number\)\}<\/div>\s*\{j\.dispatched_at && \([\s\S]*?Dispatched \{date\(j\.dispatched_at\)\}/);
    const detail = src("src/components/shop/JobDetail.tsx");
    expect(detail).toMatch(/data\.timeline\.map\(/);
    expect(detail).toMatch(/\{s\.label\} \{date\(s\.at\)\}/);
    const data = src("src/app/shop/data.ts");
    expect(data).toMatch(/dispatched_at/);
    expect(data).toMatch(/timeline: shopTimeline\(/);
  });
});

// ------------------------------------------------------------------ B: pickup day

describe("pickup day and window", () => {
  it("the shop picks a time window or Need to coordinate; Tomorrow is replaced by the day", () => {
    expect(SHOP_PICKUP_WINDOWS.map((w) => w.value)).toEqual(["08-10", "10-12", "12-14", "14-16", "16-17", "coordinate"]);
  });

  it("checks the day: required, a real date, not in the past, within a year", () => {
    const today = "2026-11-18";
    expect(pickupChoiceError("2026-11-18", "08-10", today)).toBeNull();
    expect(pickupChoiceError("2027-11-18", "coordinate", today)).toBeNull();
    expect(pickupChoiceError("", "08-10", today)).toMatch(/pickup day/);
    expect(pickupChoiceError("2026-11-17", "08-10", today)).toMatch(/past/);
    expect(pickupChoiceError("2026-02-30", "08-10", today)).toMatch(/pickup day/);
    expect(pickupChoiceError("2027-11-19", "08-10", today)).toMatch(/year/);
    expect(pickupChoiceError("2026-11-20", "", today)).toMatch(/window/);
    expect(pickupChoiceError("2026-11-20", "tomorrow", today)).toMatch(/window/);
  });

  it("is shown as weekday, date and window", () => {
    expect(weekdayOf("2026-11-20")).toBe("Fri");
    expect(pickupEtaLabel("08-10", "2026-11-20")).toBe("Fri 2026-11-20, 8:00 AM - 10:00 AM");
    expect(pickupEtaLabel("coordinate", "2026-11-20")).toBe("Fri 2026-11-20, Need to coordinate");
    // Orders accepted before the day existed keep their window only.
    expect(pickupEtaLabel("tomorrow", null)).toBe("Tomorrow");
    expect(pickupEtaLabel(null, null)).toBe("Not accepted yet");
  });

  it("the acceptance email to dispatch@ has the day", () => {
    expect(acceptedEta("10-12", "2026-11-20")).toBe("Fri 2026-11-20, 10:00 AM - 12:00 PM");
    expect(acceptedEta("10-12", null)).toBe("10:00 AM - 12:00 PM");
    expect(acceptedEta(null, null)).toBeNull();
  });

  it("accepting a pickup job sends the day and the window", async () => {
    const res = await acceptJob(WO, {}, form({ pickup_date: soon(2), pickup_window: "08-10" }));
    expect(res.error).toBeUndefined();
    expect(rpcs).toEqual([
      { fn: "shop_accept_work_order", args: { p_work_order: WO, p_pickup_date: soon(2), p_pickup_window: "08-10" } },
    ]);
  });

  it("accepting a shipped job sends no day", async () => {
    await acceptJob(WO, {}, form({}));
    expect(rpcs[0].args).toEqual({ p_work_order: WO, p_pickup_date: null, p_pickup_window: null });
  });

  it("refuses a past day or Tomorrow before calling the database", async () => {
    expect((await acceptJob(WO, {}, form({ pickup_date: "2020-01-01", pickup_window: "08-10" }))).error).toMatch(/past/);
    expect((await acceptJob(WO, {}, form({ pickup_date: soon(2), pickup_window: "tomorrow" }))).error).toMatch(/window/);
    expect(rpcs).toEqual([]);
  });

  it("the shop changes the day and window with shop_set_pickup", async () => {
    const res = await changePickup(WO, {}, form({ pickup_date: soon(3), pickup_window: "coordinate" }));
    expect(res.error).toBeUndefined();
    expect(rpcs).toEqual([
      { fn: "shop_set_pickup", args: { p_work_order: WO, p_pickup_date: soon(3), p_pickup_window: "coordinate" } },
    ]);
    expect((await changePickup(WO, {}, form({ pickup_date: "", pickup_window: "08-10" }))).error).toMatch(/pickup day/);
  });

  it("the CDS order page and the Pickup / Delivery list show the day with the window", () => {
    expect(src("src/app/cds/pickup/page.tsx")).toMatch(/pickupEtaLabel\(r\.pickup_window, r\.pickup_date\)/);
    expect(src("src/app/cds/work-orders/[id]/page.tsx")).toMatch(/pickupEtaLabel\(wo\.pickup_window, wo\.pickup_date\)/);
  });
});

// ------------------------------------------------------------------ B: calendar

describe("shop calendar", () => {
  it("reads ?month=YYYY-MM, else the current Pacific month", () => {
    expect(parseMonth("2026-12", "2026-11-18")).toBe("2026-12");
    expect(parseMonth(undefined, "2026-11-18")).toBe("2026-11");
    expect(parseMonth("2026-13", "2026-11-18")).toBe("2026-11");
    expect(parseMonth("x", "2026-11-18")).toBe("2026-11");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthLabel("2026-11")).toBe("November 2026");
    expect(monthRange("2026-11")).toEqual({ first: "2026-11-01", last: "2026-11-30" });
    expect(monthRange("2028-02")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
  });

  it("lays the month out in weeks from Sunday", () => {
    const weeks = monthWeeks("2026-11");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]);
    expect(weeks[4]).toEqual(["2026-11-29", "2026-11-30", null, null, null, null, null]);
    const dec = monthWeeks("2026-12"); // starts on a Tuesday
    expect(dec[0].slice(0, 3)).toEqual([null, null, "2026-12-01"]);
  });

  const job = (over: Partial<CalendarJob>): CalendarJob => ({
    id: "id",
    wo_number: 1,
    status: "accepted",
    fulfillment: "pickup",
    customer_name: "Customer",
    location_label: "Yard",
    unit_number: "U1",
    pickup_date: null,
    pickup_window: null,
    received_at: null,
    ...over,
  });

  it("puts pickup jobs on their pickup day and shipped jobs on the Pacific day they arrived", () => {
    const days = calendarEntries(
      [
        job({ id: "p2", wo_number: 2, pickup_date: "2026-11-20", pickup_window: "12-14" }),
        job({ id: "p1", wo_number: 3, pickup_date: "2026-11-20", pickup_window: "08-10" }),
        job({ id: "pc", wo_number: 4, pickup_date: "2026-11-20", pickup_window: "coordinate" }),
        // Arrived 2026-11-21 03:00 UTC = 2026-11-20 evening in California.
        job({ id: "s1", wo_number: 5, fulfillment: "shipping", status: "in_process", received_at: "2026-11-21T03:00:00Z" }),
        job({ id: "none", wo_number: 6, pickup_window: "tomorrow" }), // accepted before the day existed
        job({ id: "ship-none", wo_number: 7, fulfillment: "shipping" }),
        job({ id: "other-month", wo_number: 8, pickup_date: "2026-12-01", pickup_window: "08-10" }),
      ],
      "2026-11",
    );
    expect([...days.keys()]).toEqual(["2026-11-20"]);
    expect(days.get("2026-11-20")!.map((e) => [e.id, e.kind, e.window])).toEqual([
      ["p1", "pickup", "08-10"],
      ["p2", "pickup", "12-14"],
      ["pc", "pickup", "coordinate"],
      ["s1", "received", null],
    ]);
  });

  it("a pickup job already picked up stays on its pickup day", () => {
    const days = calendarEntries([job({ status: "in_process", pickup_date: "2026-11-03", pickup_window: "08-10", received_at: "2026-11-04T16:00:00Z" })], "2026-11");
    expect([...days.keys()]).toEqual(["2026-11-03"]);
  });

  it("has a Calendar link next to the job list and back", () => {
    expect(src("src/components/shop/JobQueue.tsx")).toMatch(/href="\/shop\/calendar"/);
    const page = src("src/app/shop/calendar/page.tsx");
    expect(page).toMatch(/requireShop\(\)/);
    expect(page).toMatch(/loadCalendar\(/);
    expect(page).toMatch(/href="\/shop"/);
  });

  it("uses no en or em dashes in the new files", () => {
    for (const p of [
      "src/components/shop/calendar.ts",
      "src/app/shop/calendar/page.tsx",
      "src/lib/pickup.ts",
      "supabase/migrations/20261119130000_shop_pickup_date.sql",
    ]) {
      expect(src(p), p).not.toMatch(/[–—]/);
    }
  });
});
