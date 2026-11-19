/**
 * Reminder rules for shops (Sarah, CDS, 2026-11-19), weekday hours only (Pacific weekends are
 * skipped):
 *   - dispatched but not accepted: after 24 weekday hours, then every 24 until accepted or
 *     declined;
 *   - accepted and open with no shop update: after 24 weekday hours, then every 24;
 *   - not completed: after 48 weekday hours, then every 12. Pickup orders count from the
 *     acceptance, shipped orders from when the part arrived at the shop.
 * Every clock starts no earlier than when the shop's emails were turned on. Each reminder has a
 * fixed key, so recording it twice (cron reruns) is one email.
 */
import { describe, expect, it } from "vitest";
import { dueReminders, type ReminderCandidate } from "@/lib/shop-email-reminders";

const WO = "11111111-1111-4111-8111-111111111111";
const SHOP = "22222222-2222-4222-8222-222222222222";

// Tue 2026-11-17 08:00 PT (PST, UTC-8) and friends.
const TUE_8 = "2026-11-17T16:00:00.000Z";
const WED_8 = "2026-11-18T16:00:00.000Z";
const THU_8 = "2026-11-19T16:00:00.000Z";
const FRI_8 = "2026-11-20T16:00:00.000Z";
const FRI_20 = "2026-11-21T04:00:00.000Z";
const SAT_12 = "2026-11-21T20:00:00.000Z";
const MON_8 = "2026-11-23T16:00:00.000Z";
const ENABLED_LONG_AGO = "2026-11-01T16:00:00.000Z";

const at = (iso: string, plusHours = 0) => Date.parse(iso) + plusHours * 3_600_000;

function candidate(over: Partial<ReminderCandidate>): ReminderCandidate {
  return {
    workOrderId: WO,
    affiliateId: SHOP,
    status: "awaiting_acceptance",
    fulfillment: "pickup",
    enabledAt: ENABLED_LONG_AGO,
    dispatchedAt: TUE_8,
    acceptedAt: null,
    pickedUpAt: null,
    arrivedAt: null,
    lastShopUpdateAt: null,
    ...over,
  };
}

const kinds = (c: ReminderCandidate, now: number) => dueReminders(c, now).map((r) => r.kind);

describe("not accepted", () => {
  it("is not due before 24 weekday hours", () => {
    expect(dueReminders(candidate({}), at(WED_8, -0.01))).toEqual([]);
  });

  it("is due once at 24 weekday hours, with a key that does not change within the period", () => {
    const first = dueReminders(candidate({}), at(WED_8));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "not_accepted", since: TUE_8, count: 1 });
    const later = dueReminders(candidate({}), at(WED_8, 23));
    expect(later[0].key).toBe(first[0].key);
  });

  it("repeats every 24 weekday hours with a new key", () => {
    const one = dueReminders(candidate({}), at(WED_8))[0];
    const two = dueReminders(candidate({}), at(THU_8))[0];
    expect(two.count).toBe(2);
    expect(two.key).not.toBe(one.key);
  });

  it("skips the weekend: dispatched Friday 20:00 PT is due Monday 20:00 PT, not Saturday", () => {
    const c = candidate({ dispatchedAt: FRI_20 });
    expect(dueReminders(c, at(SAT_12, 30))).toEqual([]); // Sunday evening
    expect(dueReminders(c, at(MON_8, 11.9))).toEqual([]); // Monday 19:54 PT: 23.9 weekday hours
    expect(kinds(c, at(MON_8, 12))).toEqual(["not_accepted"]); // Monday 20:00 PT
  });

  it("counts from when the shop's emails were turned on, not from an older dispatch", () => {
    const c = candidate({ dispatchedAt: "2026-11-02T16:00:00.000Z", enabledAt: THU_8 });
    expect(dueReminders(c, at(THU_8, 1))).toEqual([]);
    const r = dueReminders(c, at(FRI_8));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ since: THU_8, count: 1 });
  });

  it("stops once the order is accepted", () => {
    const c = candidate({ status: "accepted", acceptedAt: WED_8, lastShopUpdateAt: WED_8 });
    expect(kinds(c, at(WED_8, 1))).not.toContain("not_accepted");
  });
});

describe("no update", () => {
  const accepted = (over: Partial<ReminderCandidate> = {}) =>
    candidate({ status: "accepted", acceptedAt: TUE_8, lastShopUpdateAt: TUE_8, ...over });

  it("is due 24 weekday hours after the acceptance when the shop did nothing since", () => {
    expect(dueReminders(accepted(), at(WED_8, -0.5))).toEqual([]);
    const r = dueReminders(accepted(), at(WED_8));
    expect(r).toMatchObject([{ kind: "no_update", since: TUE_8, count: 1 }]);
  });

  it("restarts from the shop's last update (a new key, so the old reminder does not count)", () => {
    const before = dueReminders(accepted(), at(WED_8))[0];
    const c = accepted({ lastShopUpdateAt: WED_8 });
    expect(dueReminders(c, at(WED_8, 5))).toEqual([]);
    const after = dueReminders(c, at(THU_8));
    expect(after[0]).toMatchObject({ kind: "no_update", since: WED_8 });
    expect(after[0].key).not.toBe(before.key);
  });

  it("is never sent for an order that is not accepted yet", () => {
    expect(kinds(candidate({}), at(THU_8))).toEqual(["not_accepted"]);
  });
});

describe("not completed", () => {
  it("pickup order: due 48 weekday hours after the acceptance, then every 12", () => {
    // Updated by the shop all along, so only this rule can be due.
    const c = (now: string) => candidate({ status: "in_process", acceptedAt: TUE_8, lastShopUpdateAt: now });
    expect(kinds(c(THU_8), at(THU_8, -0.1))).toEqual([]);
    expect(dueReminders(c(THU_8), at(THU_8))).toMatchObject([{ kind: "not_completed", since: TUE_8, count: 1 }]);
    expect(dueReminders(c(THU_8), at(THU_8, 11.9))[0].count).toBe(1);
    expect(dueReminders(c(THU_8), at(THU_8, 12))[0].count).toBe(2);
    expect(dueReminders(c(FRI_8), at(FRI_8))[0].count).toBe(3);
  });

  it("shipped order: counts from when the part arrived, not from dispatch or acceptance", () => {
    const c = candidate({
      status: "accepted",
      fulfillment: "shipping",
      acceptedAt: TUE_8,
      arrivedAt: THU_8,
      lastShopUpdateAt: "2026-11-23T15:00:00.000Z",
    });
    // Thursday 08:00 + 48 weekday hours = Monday 08:00 (Fri 16 + Mon 8 skipping the weekend).
    expect(kinds(c, at(MON_8, -0.1))).toEqual([]);
    expect(dueReminders(c, at(MON_8))).toMatchObject([{ kind: "not_completed", since: THU_8, count: 1 }]);
  });

  it("shipped order whose part has not arrived: no completion clock yet", () => {
    const c = candidate({ status: "accepted", fulfillment: "shipping", acceptedAt: TUE_8, lastShopUpdateAt: FRI_8 });
    expect(kinds(c, at(FRI_8, 1))).toEqual([]);
  });

  it("shipped order marked Picked Up without a tracked delivery counts from Picked Up", () => {
    const c = candidate({ status: "picked_up", fulfillment: "shipping", acceptedAt: TUE_8, pickedUpAt: TUE_8, lastShopUpdateAt: THU_8 });
    expect(dueReminders(c, at(THU_8))).toMatchObject([{ kind: "not_completed", since: TUE_8 }]);
  });

  it("when both are due, one email: the completion reminder, the no update one is recorded as covered", () => {
    const c = candidate({ status: "in_process", acceptedAt: TUE_8, lastShopUpdateAt: TUE_8 });
    const due = dueReminders(c, at(THU_8));
    expect(due.map((r) => [r.kind, r.covered])).toEqual([
      ["no_update", true],
      ["not_completed", false],
    ]);
  });

  it("counts from when the shop's emails were turned on", () => {
    const c = candidate({ status: "in_process", acceptedAt: "2026-11-02T16:00:00.000Z", lastShopUpdateAt: FRI_8, enabledAt: FRI_8 });
    expect(kinds(c, at(FRI_8, 2))).toEqual([]);
  });
});

it("never reminds about a completed or cancelled order", () => {
  for (const status of ["completed", "cancelled", "delivered", "rejected_by_affiliate"]) {
    expect(dueReminders(candidate({ status, acceptedAt: TUE_8 }), at(MON_8))).toEqual([]);
  }
});

it("keys name the order, the shop, the rule, the clock start and the count", () => {
  const [r] = dueReminders(candidate({}), at(WED_8));
  expect(r.key).toBe(`not_accepted:${WO}:${SHOP}:${Date.parse(TUE_8)}:1`);
});
