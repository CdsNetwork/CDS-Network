/**
 * Emails to shops (Sarah, CDS, 2026-11-19; 20261120200000_shop_emails.sql):
 *   - the per-shop switch: CDS only, off by default, never for CDS's in-house shop, with the
 *     time it was turned on kept by the database;
 *   - notices queued by the database for shops with emails on: dispatch, a shop-visible CDS
 *     note (never an internal note, never the shop's own note), extra work decisions, and line
 *     changes by CDS debounced into one email;
 *   - the history is CDS only: shops read none of it, and cannot call the sender's functions;
 *   - the sender (run against this database with Resend faked) mails every dispatch contact of
 *     the shop in one email, never a price, and records each reminder once.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runShopEmails } from "@/lib/shop-email-run";
import { dueReminders } from "@/lib/shop-email-reminders";
import { supabaseShopEmailStore } from "@/lib/shop-email-store";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `SE-${runId}`;
const suffix = `%-${runId}`;
const ENV = { PORTAL_EMAILS_ENABLED: "true", RESEND_SEND_API_KEY: "re_test_fake", PORTAL_PUBLIC_URL: "https://portal.example.com" };
const store = supabaseShopEmailStore(admin);

let shopA: string;
let shopB: string;
let shopOff: string;
let customer: string;
let item: string;
let cds: Login;
let loginA: Login;
let loginB: Login;

async function insertOne(table: string, row: Record<string, unknown>): Promise<{ id: string }> {
  return must(admin.from(table).insert(row).select("id").single()) as Promise<{ id: string }>;
}

/** An order in review with one line, ready for CDS to dispatch. */
async function order(unit: string, fulfillment: "pickup" | "shipping" = "shipping"): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment,
    status: "pending_review",
    unit_number: unit,
    po_number: `PO-${unit}`,
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: item, qty: 1, origin: "cds_order" }));
  return wo.id;
}

const dispatch = (wo: string, shop: string) => must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: wo, p_affiliate: shop }));

const emails = async (wo: string) =>
  (await must(
    admin.from("shop_emails").select("id, kind, affiliate_id, status, ref_id, send_after, recipients, note").eq("work_order_id", wo).order("id"),
  )) as { id: number; kind: string; affiliate_id: string; status: string; ref_id: string | null; send_after: string; recipients: string[]; note: string | null }[];

function fakeResend() {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: `email_fake_${runId}` }), { status: 200 }));
}

beforeAll(async () => {
  shopA = (await insertOne("affiliates", { short_code: `SEA-${runId}`, display_name: `Email Shop A ${runId}` })).id;
  shopB = (await insertOne("affiliates", { short_code: `SEB-${runId}`, display_name: `Email Shop B ${runId}` })).id;
  shopOff = (await insertOne("affiliates", { short_code: `SEO-${runId}`, display_name: `Email Shop Off ${runId}` })).id;
  customer = (await insertOne("customers", { code: `SEC-${runId}`, name: `Email Customer ${runId}` })).id;
  item = (await insertOne("catalog_items", { sku: `SEDPF-${runId}`, category: "service", name: "Test DPF cleaning", tax_class: "labor" })).id;
  // Amounts that must never appear in an email.
  await must(admin.from("sell_prices").insert({ catalog_item_id: item, market: "US", amount: 987.65, effective_from: "2026-01-01" }));
  await must(admin.from("shop_rates").insert({ catalog_item_id: item, market: "US", amount: 432.1, effective_from: "2026-01-01" }));
  await must(
    admin.from("affiliate_contacts").insert([
      { affiliate_id: shopA, email: `dispatch-a-${runId.toLowerCase()}@example.com`, receives_dispatch: true },
      { affiliate_id: shopA, email: `owner-a-${runId.toLowerCase()}@example.com`, receives_dispatch: true },
      { affiliate_id: shopA, email: `billing-a-${runId.toLowerCase()}@example.com`, receives_dispatch: false },
      { affiliate_id: shopB, email: `dispatch-b-${runId.toLowerCase()}@example.com`, receives_dispatch: true },
      { affiliate_id: shopOff, email: `dispatch-o-${runId.toLowerCase()}@example.com`, receives_dispatch: true },
    ]),
  );
  cds = await createLogin("cds", null);
  loginA = await createLogin("shop", shopA);
  loginB = await createLogin("shop", shopB);
  await must(cds.client.from("affiliates").update({ shop_emails_enabled: true }).in("id", [shopA, shopB]));
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("shop_rates").delete().eq("catalog_item_id", item));
  await must(admin.from("sell_prices").delete().eq("catalog_item_id", item));
  await must(admin.from("catalog_items").delete().like("sku", suffix));
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
  await must(admin.from("audit_log").delete().in("row_id", [shopA, shopB, shopOff, customer, item, cds?.id, loginA?.id, loginB?.id].filter(Boolean)));
}, 120_000);

describe("the per-shop switch", () => {
  it("is off for a new shop", async () => {
    const row = await must(admin.from("affiliates").select("shop_emails_enabled, shop_emails_enabled_at").eq("id", shopOff).single());
    expect(row).toEqual({ shop_emails_enabled: false, shop_emails_enabled_at: null });
  });

  it("a shop cannot turn it on or off, for itself or another shop", async () => {
    for (const [login, target] of [
      [loginB, shopOff],
      [loginA, shopA],
      [loginA, shopB],
    ] as const) {
      const value = target === shopOff;
      const { data } = await login.client.from("affiliates").update({ shop_emails_enabled: value }).eq("id", target).select("id");
      expect(data ?? []).toEqual([]);
    }
    const rows = await must(admin.from("affiliates").select("id, shop_emails_enabled").in("id", [shopA, shopB, shopOff]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.shop_emails_enabled]))).toEqual({ [shopA]: true, [shopB]: true, [shopOff]: false });
  });

  it("CDS turns it on and off; the database keeps when it was turned on", async () => {
    const before = Date.now();
    await must(cds.client.from("affiliates").update({ shop_emails_enabled: true }).eq("id", shopOff));
    const on = await must(admin.from("affiliates").select("shop_emails_enabled_at").eq("id", shopOff).single());
    expect(Date.parse(on.shop_emails_enabled_at as string)).toBeGreaterThan(before - 60_000);

    // Saving other shop fields, or writing the time directly, does not move it.
    await must(cds.client.from("affiliates").update({ hours_note: "Mon to Fri", shop_emails_enabled_at: "2020-01-01T00:00:00Z" }).eq("id", shopOff));
    const kept = await must(admin.from("affiliates").select("shop_emails_enabled_at").eq("id", shopOff).single());
    expect(kept.shop_emails_enabled_at).toBe(on.shop_emails_enabled_at);

    await must(cds.client.from("affiliates").update({ shop_emails_enabled: false }).eq("id", shopOff));
    expect(await must(admin.from("affiliates").select("shop_emails_enabled, shop_emails_enabled_at").eq("id", shopOff).single())).toEqual({
      shop_emails_enabled: false,
      shop_emails_enabled_at: null,
    });
  });

  it("CDS's in-house shop can never be turned on", async () => {
    const inHouse = await must(admin.from("affiliates").select("id").eq("is_in_house", true).maybeSingle());
    if (!inHouse) return; // a database without the in-house shop
    const { error } = await cds.client.from("affiliates").update({ shop_emails_enabled: true }).eq("id", inHouse.id);
    expect(error?.message).toMatch(/in-house shop is never emailed/);
    expect((await must(admin.from("affiliates").select("shop_emails_enabled").eq("id", inHouse.id).single())).shop_emails_enabled).toBe(false);
  });
});

describe("notices queued by the database", () => {
  it("a dispatch to a shop with emails on queues one notice; to a shop with emails off, none", async () => {
    const on = await order("SE-1");
    await dispatch(on, shopA);
    expect((await emails(on)).map((e) => [e.kind, e.affiliate_id, e.status])).toEqual([["dispatch", shopA, "pending"]]);

    const off = await order("SE-2");
    await dispatch(off, shopOff);
    expect(await emails(off)).toEqual([]);
  });

  it("re-dispatching to the same shop (double click) queues nothing more; moving it to another shop queues its notice", async () => {
    const wo = await order("SE-3");
    await dispatch(wo, shopA);
    await dispatch(wo, shopA);
    await dispatch(wo, shopB);
    expect((await emails(wo)).map((e) => [e.kind, e.affiliate_id])).toEqual([
      ["dispatch", shopA],
      ["dispatch", shopB],
    ]);
  });

  it("a CDS note the shop sees queues a notice; an internal note or the shop's own note does not", async () => {
    const wo = await order("SE-4");
    await dispatch(wo, shopA);
    const note = (await must(cds.client.from("work_order_notes").insert({ work_order_id: wo, author_id: cds.id, body: "Please call before pickup" }).select("id").single())) as { id: string };
    await must(cds.client.from("work_order_internal_notes").insert({ work_order_id: wo, author_id: cds.id, body: "Internal: margin is thin" }));
    await must(loginA.client.from("work_order_notes").insert({ work_order_id: wo, body: "Shop note" }));
    expect((await emails(wo)).map((e) => [e.kind, e.ref_id])).toEqual([
      ["dispatch", null],
      ["note", note.id],
    ]);
  });

  it("several line changes by CDS become one delayed notice", async () => {
    const wo = await order("SE-5");
    await dispatch(wo, shopA);
    await must(cds.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: item, qty: 2, origin: "cds_order" }));
    await must(cds.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: item, qty: 3, origin: "cds_order" }));
    const lines = (await emails(wo)).filter((e) => e.kind === "lines");
    expect(lines).toHaveLength(1);
    expect(lines[0].status).toBe("pending");
    expect(Date.parse(lines[0].send_after)).toBeGreaterThan(Date.now() + 60_000);
  });

  it("CDS deciding a shop's extra work request queues the decision, not a line change", async () => {
    const wo = await order("SE-6");
    await dispatch(wo, shopA);
    await must(loginA.client.rpc("shop_accept_work_order", { p_work_order: wo, p_pickup_window: null, p_pickup_date: null }));
    await must(loginA.client.rpc("shop_request_authorization", { p_work_order: wo, p_catalog_item: item, p_qty: 1, p_note: "Second filter is cracked" }));
    const req = await must(admin.from("authorization_requests").select("id").eq("work_order_id", wo).single());
    await must(
      cds.client.rpc("cds_decide_authorization", { p_request: req.id, p_approve: true, p_decision_note: "OK per fleet", p_customer_approved_by: "Fleet manager" }),
    );
    expect((await emails(wo)).map((e) => [e.kind, e.ref_id])).toEqual([
      ["dispatch", null],
      ["extra_work_approved", req.id],
    ]);
  });
});

describe("who reads the history", () => {
  it("shops read none of it, their own or another shop's; CDS reads it", async () => {
    const wo = await order("SE-7");
    await dispatch(wo, shopA);
    expect(await must(loginA.client.from("shop_emails").select("id").eq("work_order_id", wo))).toEqual([]);
    expect(await must(loginB.client.from("shop_emails").select("id").eq("work_order_id", wo))).toEqual([]);
    expect(await must(cds.client.from("shop_emails").select("kind").eq("work_order_id", wo))).toEqual([{ kind: "dispatch" }]);
  });

  it("shops and CDS cannot write it or call the sender's functions", async () => {
    const wo = await order("SE-8");
    for (const login of [loginA, cds]) {
      const insert = await login.client.from("shop_emails").insert({ work_order_id: wo, affiliate_id: shopA, kind: "note", dedupe_key: `x-${runId}` });
      expect(insert.error).not.toBeNull();
      expect((await login.client.rpc("shop_email_claim", { p_id: 1, p_max_attempts: 3 })).error?.code).toBe("42501");
      expect((await login.client.rpc("shop_email_reminder_candidates")).error?.code).toBe("42501");
    }
  });
});

describe("sending (Resend faked)", () => {
  it("mails every dispatch contact of the shop in one email, with no price, and records it", async () => {
    const wo = await order("SE-9");
    await dispatch(wo, shopA);
    await must(cds.client.from("work_order_notes").insert({ work_order_id: wo, author_id: cds.id, body: "Pickup is at the north gate" }));
    const fetchImpl = fakeResend();
    const out = await runShopEmails(store, { env: ENV, fetchImpl, workOrderIds: [wo], reminders: false });
    expect(out).toMatchObject({ sent: 2, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const to = [`dispatch-a-${runId.toLowerCase()}@example.com`, `owner-a-${runId.toLowerCase()}@example.com`];
    for (const [, init] of fetchImpl.mock.calls) {
      const body = JSON.parse(String(init!.body));
      expect(body.to).toEqual(to);
      for (const part of [body.subject, body.text, body.html]) expect(part).not.toMatch(/987|432|\$/);
      expect(body.text).toContain(`Email Shop A ${runId}`);
      expect(body.text).toContain(`https://portal.example.com/shop?job=${wo}`);
    }
    expect((await emails(wo)).map((e) => [e.kind, e.status, e.recipients])).toEqual([
      ["dispatch", "sent", to],
      ["note", "sent", to],
    ]);
    // A second run sends nothing more.
    await runShopEmails(store, { env: ENV, fetchImpl, workOrderIds: [wo], reminders: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("records a notice as skipped when CDS turned the shop's emails off before it went out", async () => {
    const wo = await order("SE-10");
    await dispatch(wo, shopB);
    await must(cds.client.from("affiliates").update({ shop_emails_enabled: false }).eq("id", shopB));
    try {
      const fetchImpl = fakeResend();
      await runShopEmails(store, { env: ENV, fetchImpl, workOrderIds: [wo], reminders: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect((await emails(wo)).map((e) => [e.status, e.note])).toEqual([["skipped", "Not sent: emails to this shop are turned off."]]);
    } finally {
      await must(cds.client.from("affiliates").update({ shop_emails_enabled: true }).eq("id", shopB));
    }
  });

  it("finds an unaccepted order as a reminder candidate, and records and sends its reminder once", async () => {
    const wo = await order("SE-11");
    await dispatch(wo, shopB);
    await runShopEmails(store, { env: ENV, fetchImpl: fakeResend(), workOrderIds: [wo], reminders: false }); // the dispatch notice

    const [candidate] = await store.reminderCandidates([wo]);
    expect(candidate).toMatchObject({ workOrderId: wo, affiliateId: shopB, status: "awaiting_acceptance", acceptedAt: null });
    // Five days later at least 24 weekday hours have passed.
    const due = dueReminders(candidate, Date.now() + 5 * 24 * 3_600_000);
    expect(due.map((r) => r.kind)).toEqual(["not_accepted"]);
    const row = { workOrderId: wo, affiliateId: shopB, kind: due[0].kind, dedupeKey: due[0].key, since: due[0].since, status: "pending" as const };
    await store.recordReminders([row]);
    await store.recordReminders([row]);

    const fetchImpl = fakeResend();
    await runShopEmails(store, { env: ENV, fetchImpl, workOrderIds: [wo], reminders: false });
    await runShopEmails(store, { env: ENV, fetchImpl, workOrderIds: [wo], reminders: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body)).subject).toMatch(/reminder: please accept or decline/);
    expect((await emails(wo)).map((e) => [e.kind, e.status])).toEqual([
      ["dispatch", "sent"],
      ["not_accepted", "sent"],
    ]);
  });

  it("counts a shop's note as its last update", async () => {
    const wo = await order("SE-12");
    await dispatch(wo, shopB);
    await must(loginB.client.rpc("shop_accept_work_order", { p_work_order: wo, p_pickup_window: null, p_pickup_date: null }));
    const [accepted] = await store.reminderCandidates([wo]);
    await new Promise((r) => setTimeout(r, 1100));
    await must(loginB.client.from("work_order_notes").insert({ work_order_id: wo, body: "Waiting on the part" }));
    const [noted] = await store.reminderCandidates([wo]);
    expect(Date.parse(noted.lastShopUpdateAt!)).toBeGreaterThan(Date.parse(accepted.lastShopUpdateAt!));
  });
});
