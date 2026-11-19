/**
 * Emails to shops (Sarah, CDS, 2026-11-19): who gets them, what they say, and when nothing is
 * sent. Resend is faked: nothing leaves the machine.
 */
import { describe, expect, it, vi } from "vitest";
import { PORTAL_FROM } from "@/lib/portal-email";
import { buildShopEmail, shopJobUrl, shopRecipients, type ShopEmailDetails, type ShopEmailKind } from "@/lib/shop-email";
import { runShopEmails, type ShopEmailContext, type ShopEmailRow, type ShopEmailStore } from "@/lib/shop-email-run";
import type { ReminderCandidate } from "@/lib/shop-email-reminders";

const WO = "11111111-1111-4111-8111-111111111111";
const SHOP = "22222222-2222-4222-8222-222222222222";
const OTHER_SHOP = "33333333-3333-4333-8333-333333333333";
const BASE = "https://portal.example.com";
const ENV = { PORTAL_EMAILS_ENABLED: "true", RESEND_SEND_API_KEY: "re_test_fake", PORTAL_PUBLIC_URL: BASE };

const details: ShopEmailDetails = {
  workOrderId: WO,
  woNumber: 102155,
  shopName: "Example Diesel Shop",
  location: "Fleet Yard 1234 Example City",
  unitNumber: "U-77",
  poNumber: "PO-5521",
  fulfillment: "pickup",
  lines: [
    { item: "DPF cleaning", qty: 1 },
    { item: "Gasket", qty: 2 },
  ],
  note: { author: "Pat CDS", body: "Customer asks for pickup before noon." },
  extraWork: { item: "DOC cleaning", qty: 1 },
  since: "2026-11-17T16:00:00.000Z",
};

const KINDS: ShopEmailKind[] = [
  "dispatch",
  "extra_work_approved",
  "extra_work_declined",
  "note",
  "lines",
  "not_accepted",
  "no_update",
  "not_completed",
];

describe("shopRecipients", () => {
  it("takes every contact marked to receive dispatch emails, once, and nothing else", () => {
    expect(
      shopRecipients([
        { email: "Dispatch@shop.example.com", receivesDispatch: true },
        { email: "owner@shop.example.com", receivesDispatch: true },
        { email: "dispatch@shop.example.com", receivesDispatch: true },
        { email: "billing@shop.example.com", receivesDispatch: false },
        { email: "not an email", receivesDispatch: true },
        { email: "cds-allentown.ab12@login.invalid", receivesDispatch: true },
      ]),
    ).toEqual(["dispatch@shop.example.com", "owner@shop.example.com"]);
  });

  it("is empty when no contact receives dispatch emails", () => {
    expect(shopRecipients([{ email: "billing@shop.example.com", receivesDispatch: false }])).toEqual([]);
  });
});

describe("buildShopEmail", () => {
  it("links to the job on the shop's page", () => {
    expect(shopJobUrl(WO, BASE)).toBe(`${BASE}/shop?job=${WO}`);
  });

  it.each(KINDS)("%s: names the shop, the order, location, unit and PO, and links the job", (kind) => {
    const e = buildShopEmail(kind, details, BASE);
    expect(e.subject).toMatch(/^\[Portal\] WO-102155 /);
    for (const part of [e.text, e.html]) {
      expect(part).toContain("Example Diesel Shop");
      expect(part).toContain("WO-102155");
      expect(part).toContain("Fleet Yard 1234 Example City");
      expect(part).toContain("U-77");
      expect(part).toContain("PO-5521");
      expect(part).toContain(`${BASE}/shop?job=${WO}`);
    }
  });

  it.each(KINDS)("%s: no prices, no amounts and no em or en dashes", (kind) => {
    const e = buildShopEmail(kind, details, BASE);
    // The HTML part without its tags (its inline CSS says "margin").
    for (const part of [e.subject, e.text, e.html.replace(/<[^>]*>/g, " ")]) {
      expect(part).not.toMatch(/\$|USD|price|margin|cost/i);
      expect(part).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("dispatch: says it is a new job to accept or decline, with its services and parts", () => {
    const e = buildShopEmail("dispatch", details, BASE);
    expect(e.subject).toBe("[Portal] WO-102155 new job from CDS");
    expect(e.text).toMatch(/accept or decline/i);
    expect(e.text).toContain("DPF cleaning x 1");
    expect(e.text).toContain("Gasket x 2");
  });

  it("extra work: says what was approved or declined", () => {
    expect(buildShopEmail("extra_work_approved", details, BASE).text).toMatch(/approved your extra work request[\s\S]*DOC cleaning x 1/);
    expect(buildShopEmail("extra_work_declined", details, BASE).text).toMatch(/declined your extra work request[\s\S]*DOC cleaning x 1/);
  });

  it("note: gives the note and who wrote it", () => {
    const e = buildShopEmail("note", details, BASE);
    expect(e.text).toContain("Customer asks for pickup before noon.");
    expect(e.text).toContain("Pat CDS");
  });

  it("note: escapes the note in the HTML part", () => {
    const e = buildShopEmail("note", { ...details, note: { author: "Pat", body: "<b>bold</b> & more" } }, BASE);
    expect(e.html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; more");
    expect(e.html).not.toContain("<b>bold</b>");
  });

  it("lines: lists the current services and parts", () => {
    const e = buildShopEmail("lines", details, BASE);
    expect(e.subject).toBe("[Portal] WO-102155 services or parts changed by CDS");
    expect(e.text).toContain("DPF cleaning x 1");
  });

  it("reminders: say since when, in Pacific time", () => {
    expect(buildShopEmail("not_accepted", details, BASE).text).toContain("2026-11-17 08:00 PT");
    expect(buildShopEmail("no_update", details, BASE).text).toContain("2026-11-17 08:00 PT");
    expect(buildShopEmail("not_completed", details, BASE).text).toContain("2026-11-17 08:00 PT");
    expect(buildShopEmail("not_completed", { ...details, fulfillment: "shipping" }, BASE).text).toMatch(/arrived/);
  });
});

// ---------------------------------------------------------------- the sender

type Fake = ShopEmailStore & {
  rows: (ShopEmailRow & { status: string; recipients?: string[]; note?: string | null; subject?: string | null; provider_id?: string | null })[];
};

function context(over: Partial<ShopEmailContext> = {}): ShopEmailContext {
  return {
    order: {
      id: WO,
      woNumber: 102155,
      status: "awaiting_acceptance",
      affiliateId: SHOP,
      location: "Fleet Yard 1234 Example City",
      unitNumber: "U-77",
      poNumber: "PO-5521",
      fulfillment: "pickup",
    },
    shop: { name: "Example Diesel Shop", emailsEnabled: true, inHouse: false, active: true },
    contacts: [
      { email: "dispatch@shop.example.com", receivesDispatch: true },
      { email: "owner@shop.example.com", receivesDispatch: true },
      { email: "billing@shop.example.com", receivesDispatch: false },
    ],
    note: null,
    extraWork: null,
    lines: [{ item: "DPF cleaning", qty: 1 }],
    ...over,
  };
}

function fakeStore(rows: Partial<ShopEmailRow>[], ctx: ShopEmailContext | null = context(), candidates: ReminderCandidate[] = []): Fake {
  let nextId = 100;
  const store: Fake = {
    rows: rows.map((r, i) => ({
      id: i + 1,
      workOrderId: WO,
      affiliateId: SHOP,
      kind: "dispatch",
      refId: null,
      since: null,
      createdAt: new Date().toISOString(),
      status: "pending",
      ...r,
    })) as Fake["rows"],
    reminderCandidates: vi.fn(async () => candidates),
    recordReminders: vi.fn(async (list) => {
      for (const r of list) {
        if (store.rows.some((x) => x.dedupeKey === r.dedupeKey)) continue;
        store.rows.push({ id: nextId++, workOrderId: r.workOrderId, affiliateId: r.affiliateId, kind: r.kind, refId: null, since: r.since, createdAt: new Date().toISOString(), dedupeKey: r.dedupeKey, status: r.status, note: r.note ?? null });
      }
    }),
    dueRows: vi.fn(async () => store.rows.filter((r) => r.status === "pending")),
    claim: vi.fn(async (id: number) => {
      const row = store.rows.find((r) => r.id === id);
      if (!row || row.status !== "pending") return false;
      row.status = "sending";
      return true;
    }),
    context: vi.fn(async () => ctx),
    finish: vi.fn(async (id, patch) => {
      Object.assign(store.rows.find((r) => r.id === id)!, patch);
    }),
    skipDue: vi.fn(async (note: string) => {
      let n = 0;
      for (const r of store.rows.filter((x) => x.status === "pending")) {
        r.status = "skipped";
        r.note = note;
        n += 1;
      }
      return n;
    }),
  };
  return store;
}

function fakeResend(ok = true) {
  return vi.fn<typeof fetch>(async () =>
    ok
      ? new Response(JSON.stringify({ id: "email_fake_1" }), { status: 200 })
      : new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
  );
}

describe("runShopEmails", () => {
  it("sends one email to every dispatch contact of the shop and records it", async () => {
    const store = fakeStore([{ kind: "dispatch" }]);
    const fetchImpl = fakeResend();
    const out = await runShopEmails(store, { env: ENV, fetchImpl });
    expect(out).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init!.body));
    expect(body.from).toBe(PORTAL_FROM);
    expect(body.to).toEqual(["dispatch@shop.example.com", "owner@shop.example.com"]);
    expect(body.subject).toBe("[Portal] WO-102155 new job from CDS");
    expect((init!.headers as Record<string, string>)["Idempotency-Key"]).toBe("shop-email-1");
    expect(store.rows[0]).toMatchObject({
      status: "sent",
      recipients: ["dispatch@shop.example.com", "owner@shop.example.com"],
      provider_id: "email_fake_1",
    });
  });

  it("sends nothing and records skipped while PORTAL_EMAILS_ENABLED is not true, and makes no reminders", async () => {
    const candidate: ReminderCandidate = {
      workOrderId: WO,
      affiliateId: SHOP,
      status: "awaiting_acceptance",
      fulfillment: "pickup",
      enabledAt: "2026-11-01T00:00:00.000Z",
      dispatchedAt: "2026-11-02T16:00:00.000Z",
      acceptedAt: null,
      pickedUpAt: null,
      arrivedAt: null,
      lastShopUpdateAt: null,
    };
    const store = fakeStore([{ kind: "dispatch" }], context(), [candidate]);
    const fetchImpl = fakeResend();
    await runShopEmails(store, { env: { ...ENV, PORTAL_EMAILS_ENABLED: "false" }, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.reminderCandidates).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: "skipped" });
  });

  const skipCases: [string, ShopEmailContext | null, RegExp][] = [
    ["the shop's switch is off", context({ shop: { ...context().shop, emailsEnabled: false } }), /turned off/],
    ["the shop is CDS's in-house shop", context({ shop: { ...context().shop, inHouse: true } }), /in-house/],
    ["no contact receives dispatch emails", context({ contacts: [{ email: "billing@shop.example.com", receivesDispatch: false }] }), /no contact/],
    ["the order moved to another shop", context({ order: { ...context().order, affiliateId: OTHER_SHOP } }), /another shop/],
    ["the order is gone", null, /gone/],
    ["a dispatch notice whose order was already accepted", context({ order: { ...context().order, status: "accepted" } }), /no longer/],
  ];
  it.each(skipCases)("sends nothing when %s", async (_name, ctx, reason) => {
    const store = fakeStore([{ kind: "dispatch" }], ctx);
    const fetchImpl = fakeResend();
    const out = await runShopEmails(store, { env: ENV, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.skipped).toBe(1);
    expect(store.rows[0].status).toBe("skipped");
    expect(store.rows[0].note).toMatch(reason);
  });

  it("skips a note notice whose note was deleted", async () => {
    const store = fakeStore([{ kind: "note", refId: "44444444-4444-4444-8444-444444444444" }], context({ order: { ...context().order, status: "in_process" } }));
    const fetchImpl = fakeResend();
    await runShopEmails(store, { env: ENV, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.rows[0].note).toMatch(/note was deleted/);
  });

  it("records an error when Resend fails, so the next run retries it", async () => {
    const store = fakeStore([{ kind: "dispatch" }]);
    const out = await runShopEmails(store, { env: ENV, fetchImpl: fakeResend(false) });
    expect(out.failed).toBe(1);
    expect(store.rows[0].status).toBe("error");
    expect(store.rows[0].note).toMatch(/HTTP 500/);
  });

  it("records an error without a Resend key", async () => {
    const store = fakeStore([{ kind: "dispatch" }]);
    const fetchImpl = fakeResend();
    await runShopEmails(store, { env: { PORTAL_EMAILS_ENABLED: "true" }, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.rows[0].status).toBe("error");
  });

  it("records a due reminder once and sends it once, however often the cron runs", async () => {
    const candidate: ReminderCandidate = {
      workOrderId: WO,
      affiliateId: SHOP,
      status: "awaiting_acceptance",
      fulfillment: "pickup",
      enabledAt: "2026-11-01T00:00:00.000Z",
      dispatchedAt: "2026-11-17T16:00:00.000Z",
      acceptedAt: null,
      pickedUpAt: null,
      arrivedAt: null,
      lastShopUpdateAt: null,
    };
    const store = fakeStore([], context(), [candidate]);
    const fetchImpl = fakeResend();
    const now = () => Date.parse("2026-11-18T17:00:00.000Z");
    await runShopEmails(store, { env: ENV, fetchImpl, now });
    await runShopEmails(store, { env: ENV, fetchImpl, now });
    await runShopEmails(store, { env: ENV, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ kind: "not_accepted", status: "sent" });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body)).subject).toMatch(/reminder/i);
  });

  it("records a covered no update reminder as skipped, and sends only the completion reminder", async () => {
    const candidate: ReminderCandidate = {
      workOrderId: WO,
      affiliateId: SHOP,
      status: "in_process",
      fulfillment: "pickup",
      enabledAt: "2026-11-01T00:00:00.000Z",
      dispatchedAt: "2026-11-16T16:00:00.000Z",
      acceptedAt: "2026-11-17T16:00:00.000Z",
      pickedUpAt: null,
      arrivedAt: null,
      lastShopUpdateAt: "2026-11-17T16:00:00.000Z",
    };
    const store = fakeStore([], context({ order: { ...context().order, status: "in_process" } }), [candidate]);
    const fetchImpl = fakeResend();
    await runShopEmails(store, { env: ENV, fetchImpl, now: () => Date.parse("2026-11-19T17:00:00.000Z") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.rows.map((r) => [r.kind, r.status])).toEqual([
      ["no_update", "skipped"],
      ["not_completed", "sent"],
    ]);
  });

  it("can leave the reminders out (the kick after a CDS change sends only that order's notices)", async () => {
    const store = fakeStore([{ kind: "dispatch" }]);
    await runShopEmails(store, { env: ENV, fetchImpl: fakeResend(), reminders: false, workOrderIds: [WO] });
    expect(store.reminderCandidates).not.toHaveBeenCalled();
    expect(store.dueRows).toHaveBeenCalledWith(expect.any(String), [WO], expect.any(Number));
  });
});
