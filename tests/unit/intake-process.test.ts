/**
 * Ingest, process, retry and the webhook handler against an in-memory store that behaves
 * like the database (unique message id, one order per email).
 */
import { describe, expect, it, vi } from "vitest";
import { ingestEmail, processEmail, type IntakeStore } from "@/lib/intake/process";
import { tokenMatches, presentedToken } from "@/lib/intake/token";
import { handleIntakeWebhook } from "@/lib/intake/webhook";
import { fakeLlm } from "../fixtures/intake/llm-fakes";
import { fixture } from "../fixtures/intake/reference";
import { ryderEgrReturn, ryderPoIssued, ryderTextRows, ryderTextRowsNoUnit } from "../fixtures/intake/templates";
import { memoryStore } from "../fixtures/intake/memory-store";

describe("ingestEmail", () => {
  it("creates one draft order for a work request", async () => {
    const { store, drafts, rows } = memoryStore();
    const out = await ingestEmail(store, fixture("ryder-dpf-pickup"), { source: "webhook", llm: null });
    expect(out).toMatchObject({ duplicate: false, status: "converted" });
    expect(out.workOrderId).toBeTruthy();
    expect(drafts).toHaveLength(1);
    expect(rows.get(out.id)?.parsed?.customer?.via).toBe("sender_domain");
    expect(rows.get(out.id)?.attempts).toBe(1);
  });

  it("never processes the same message id twice", async () => {
    const { store, drafts } = memoryStore();
    const llm = vi.fn(fakeLlm());
    const first = await ingestEmail(store, fixture("ryder-dpf-pickup"), { source: "webhook", llm });
    const again = await ingestEmail(store, fixture("duplicate-message-id"), { source: "webhook", llm });
    expect(again).toMatchObject({ id: first.id, duplicate: true, status: "converted", workOrderId: first.workOrderId });
    expect(drafts).toHaveLength(1);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("ignores a non work request and makes no order", async () => {
    const { store, drafts } = memoryStore();
    const out = await ingestEmail(store, fixture("not-work-request"), { source: "webhook", llm: null });
    expect(out).toMatchObject({ status: "ignored", workOrderId: null, message: "Payment or remittance notice" });
    expect(drafts).toHaveLength(0);
  });

  it("stops at parsed when the customer is unknown", async () => {
    const { store, rows } = memoryStore();
    const out = await ingestEmail(store, { ...fixture("ryder-dpf-pickup"), messageId: "x-1", from: "a@unknown.example" }, { source: "paste", llm: null });
    expect(out.status).toBe("parsed");
    expect(rows.get(out.id)?.error).toMatch(/Customer not recognised/);
    expect(rows.get(out.id)?.parsed).not.toBeNull();
  });

  it("marks the email failed, keeps what was read, and converts on retry", async () => {
    const failing = memoryStore({ failDraft: true });
    const out = await ingestEmail(failing.store, fixture("first-student-parts"), { source: "webhook", llm: null });
    expect(out.status).toBe("failed");
    const row = failing.rows.get(out.id)!;
    expect(row.error).toBe("No customer price for catalog item");
    expect(row.parsed?.customer).not.toBeNull();

    // Retry against a store whose draft creation works, with the same row.
    const ok = memoryStore();
    ok.rows.set(out.id, { ...row });
    const retry = await processEmail(ok.store, out.id, { llm: null });
    expect(retry.status).toBe("converted");
    expect(ok.rows.get(out.id)?.attempts).toBe(2);
  });

  it("does nothing on retry when the email is already converted", async () => {
    const { store, drafts } = memoryStore();
    const out = await ingestEmail(store, fixture("ryder-dpf-pickup"), { source: "webhook", llm: null });
    const retry = await processEmail(store, out.id, { llm: null });
    expect(retry).toMatchObject({ status: "converted", workOrderId: out.workOrderId });
    expect(drafts).toHaveLength(1);
  });

  it("can turn an ignored email into a draft when CDS forces it", async () => {
    const { store } = memoryStore();
    const out = await ingestEmail(store, fixture("not-work-request"), { source: "webhook", llm: null });
    expect(out.status).toBe("ignored");
    const forced = await processEmail(store, out.id, { llm: null, forceWorkRequest: true });
    expect(forced.status).toBe("converted");
  });
});

describe("request templates and Ryder PO paperwork", () => {
  it("creates a high confidence draft from a Ryder form without the AI stage", async () => {
    const { store, drafts } = memoryStore();
    const llm = vi.fn(fakeLlm());
    const out = await ingestEmail(store, ryderEgrReturn, { source: "webhook", llm });
    expect(out.status).toBe("converted");
    expect(llm).not.toHaveBeenCalled();
    expect(drafts[0]).toMatchObject({ p_return_to_location: true, p_mileage: 287004, p_requested_date: "2026-10-22" });
    expect(drafts[0].p_review_reason).toMatch(/high confidence/);
  });

  it("notes Ryder PO paperwork on the open order with that PO and makes no order", async () => {
    const { store, drafts, rows } = memoryStore();
    const notePoReference = vi.fn(async () => ({ workOrderId: "wo-1", woNumber: 100245 }));
    store.notePoReference = notePoReference;
    const out = await ingestEmail(store, ryderPoIssued, { source: "webhook", llm: null });
    expect(out).toMatchObject({ status: "ignored", workOrderId: null, message: "Ryder PO paperwork: noted on work order 100245." });
    expect(notePoReference).toHaveBeenCalledWith(out.id, "0424118833");
    expect(rows.get(out.id)?.parsed?.po_reference).toEqual({ po_number: "0424118833", work_order_id: "wo-1", wo_number: 100245 });
    expect(drafts).toHaveLength(0);
  });

  it("ignores Ryder PO paperwork with no open order", async () => {
    const { store } = memoryStore();
    store.notePoReference = async () => null;
    const out = await ingestEmail(store, { ...ryderPoIssued, messageId: "<po-2@x>" }, { source: "webhook", llm: null });
    expect(out).toMatchObject({ status: "ignored", message: "Ryder PO paperwork: no open work order has PO 0424118833." });
  });
});

describe("replies and forwards on a request that already has a work order", () => {
  // The Ryder request, CDS dispatch's answer on the thread, and a Ryder person's reply to that
  // answer quoting the whole form.
  const request = { ...ryderTextRows, messageId: "<req-1@ryder.example>", receivedAt: "2026-10-27T17:43:00Z" };
  const dispatchAnswer = {
    ...request,
    messageId: "<answer-1@cds.example>",
    from: "Central Dispatch <dispatch@cds.direct>",
    subject: `Re: ${request.subject}`,
    inReplyTo: request.messageId,
    receivedAt: "2026-10-27T17:56:00Z",
    text: `Please send pictures of the filter.\n\nOn Tue wrote:\n${request.text}`,
  };
  const reply = (over: Partial<typeof request> = {}) => ({
    ...request,
    messageId: "<reply-1@ryder.example>",
    from: "Dana Sample <dana_sample@ryder.example>",
    subject: `Re: ${request.subject}`,
    inReplyTo: dispatchAnswer.messageId,
    receivedAt: "2026-10-27T18:03:00Z",
    text: `Pictures attached.\n\nFrom: Central Dispatch <dispatch@cds.direct>\n${dispatchAnswer.text}`,
    ...over,
  });

  it("links a reply to the order of its thread, followed through CDS's own answer, and makes no new draft", async () => {
    const { store, drafts, rows } = memoryStore();
    const first = await ingestEmail(store, request, { source: "webhook", llm: null });
    expect(first.status).toBe("converted");
    expect((await ingestEmail(store, dispatchAnswer, { source: "webhook", llm: null })).status).toBe("ignored");

    const out = await ingestEmail(store, reply(), { source: "webhook", llm: null });
    expect(out).toMatchObject({ status: "ignored", workOrderId: null, message: "Reply on the thread of work order 101370: no new draft." });
    expect(drafts).toHaveLength(1);
    const parsed = rows.get(out.id)?.parsed;
    expect(parsed?.ignore_kind).toBe("thread_reply");
    expect(parsed?.thread_reference).toEqual({ work_order_id: first.workOrderId, wo_number: 101370, via: "thread" });
    // What the reply says is kept for CDS to read.
    expect(parsed?.fields.unit_number.value).toBe("284177");
  });

  it("links a reply whose thread was not received by the same location and unit on a recent open order", async () => {
    const { store, drafts } = memoryStore();
    await ingestEmail(store, request, { source: "webhook", llm: null });
    const out = await ingestEmail(store, reply({ inReplyTo: "<not-stored@ryder.example>", subject: `RE: ${request.subject}` }), { source: "webhook", llm: null });
    expect(out).toMatchObject({ status: "ignored", message: "Reply on the thread of work order 101370: no new draft." });
    expect(drafts).toHaveLength(1);
  });

  it("links a forward without a unit by its subject", async () => {
    const { store, drafts, rows } = memoryStore();
    const noUnit = { ...ryderTextRowsNoUnit, messageId: "<req-2@ryder.example>", receivedAt: "2026-10-27T18:00:00Z" };
    await ingestEmail(store, noUnit, { source: "webhook", llm: null });
    const fwd = { ...noUnit, messageId: "<fwd-2@ryder.example>", from: "ryder@cds.direct", subject: `Fw: ${noUnit.subject}`, inReplyTo: "<other@ryder.example>", receivedAt: "2026-10-28T09:00:00Z" };
    const out = await ingestEmail(store, fwd, { source: "webhook", llm: null });
    expect(out.status).toBe("ignored");
    expect(rows.get(out.id)?.parsed?.thread_reference?.via).toBe("subject");
    expect(drafts).toHaveLength(1);
  });

  it("still makes a draft for a new request at the same location, and for a reply naming another unit", async () => {
    const { store, drafts } = memoryStore();
    await ingestEmail(store, request, { source: "webhook", llm: null });
    // A new request (not a reply) with the same subject: Ryder sends one per unit.
    const other = { ...request, messageId: "<req-3@ryder.example>", text: request.text!.replace("284177", "284199") };
    expect((await ingestEmail(store, other, { source: "webhook", llm: null })).status).toBe("converted");
    const otherReply = reply({ messageId: "<reply-3@ryder.example>", inReplyTo: "<not-stored@ryder.example>", text: request.text!.replace("284177", "284311") });
    expect((await ingestEmail(store, otherReply, { source: "webhook", llm: null })).status).toBe("converted");
    expect(drafts.map((d) => d.p_unit_number)).toEqual(["284177", "284199", "284311"]);
  });

  it("makes a draft for a reply when no order is open for it, or the order is older than 14 days", async () => {
    const { store, drafts } = memoryStore();
    expect((await ingestEmail(store, reply({ inReplyTo: null }), { source: "webhook", llm: null })).status).toBe("converted");

    const old = memoryStore();
    await ingestEmail(old.store, { ...request, receivedAt: "2026-10-01T10:00:00Z" }, { source: "webhook", llm: null });
    const late = await ingestEmail(old.store, reply({ inReplyTo: "<not-stored@ryder.example>" }), { source: "webhook", llm: null });
    expect(late.status).toBe("converted");
    expect(drafts).toHaveLength(1);
    expect(old.drafts).toHaveLength(2);
  });

  it("makes the draft anyway when CDS forces it", async () => {
    const { store, drafts } = memoryStore();
    await ingestEmail(store, request, { source: "webhook", llm: null });
    const out = await ingestEmail(store, reply({ inReplyTo: request.messageId }), { source: "webhook", llm: null });
    expect(out.status).toBe("ignored");
    const forced = await processEmail(store, out.id, { llm: null, forceWorkRequest: true });
    expect(forced.status).toBe("converted");
    expect(drafts).toHaveLength(2);
  });
});

describe("webhook token", () => {
  it("compares tokens exactly", () => {
    expect(tokenMatches("a".repeat(32), "a".repeat(32))).toBe(true);
    expect(tokenMatches("a".repeat(31), "a".repeat(32))).toBe(false);
    expect(tokenMatches(null, "a")).toBe(false);
    expect(tokenMatches("a", null)).toBe(false);
  });

  it("reads Bearer and x-intake-token headers", () => {
    expect(presentedToken(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(presentedToken(new Headers({ "x-intake-token": "def" }))).toBe("def");
    expect(presentedToken(new Headers())).toBeNull();
  });
});

describe("handleIntakeWebhook", () => {
  const TOKEN = "t".repeat(40);
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    new Request("https://portal.example/api/intake/email", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const email = JSON.parse(JSON.stringify(fixture("ryder-dpf-pickup")));

  it("answers 503 when no token is configured", async () => {
    const { store } = memoryStore();
    const r = await handleIntakeWebhook(post(email), { token: null, store: () => store, llm: null });
    expect(r.status).toBe(503);
  });

  it("refuses a wrong or missing token without touching the store", async () => {
    const { store, rows } = memoryStore();
    for (const headers of [{ authorization: "Bearer wrong" }, {} as Record<string, string>]) {
      const r = await handleIntakeWebhook(post(email, headers), { token: TOKEN, store: () => store, llm: null });
      expect(r.status).toBe(401);
    }
    expect(rows.size).toBe(0);
  });

  it("refuses bodies that are not a normalized email", async () => {
    const { store } = memoryStore();
    expect((await handleIntakeWebhook(post("{not json"), { token: TOKEN, store: () => store, llm: null })).status).toBe(400);
    const r = await handleIntakeWebhook(post({ from: "a@b.example" }), { token: TOKEN, store: () => store, llm: null });
    expect(r).toEqual({ status: 400, body: { error: "messageId is required" } });
  });

  it("stores and converts a request, and reports a repeat delivery as a duplicate", async () => {
    const { store, drafts } = memoryStore();
    const first = await handleIntakeWebhook(post(email), { token: TOKEN, store: () => store, llm: null });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, duplicate: false, status: "converted" });
    const second = await handleIntakeWebhook(post(email, { "x-intake-token": TOKEN }), { token: TOKEN, store: () => store, llm: null });
    expect(second.body).toMatchObject({ ok: true, duplicate: true, id: first.body.id, work_order_id: first.body.work_order_id });
    expect(drafts).toHaveLength(1);
  });

  it("answers 500 when the email cannot be stored, so the sender retries", async () => {
    const { store } = memoryStore();
    const broken: IntakeStore = { ...store, insertEmail: async () => Promise.reject(new Error("db down")) };
    const r = await handleIntakeWebhook(post(email), { token: TOKEN, store: () => broken, llm: null });
    expect(r).toEqual({ status: 500, body: { error: "not stored" } });
  });
});
