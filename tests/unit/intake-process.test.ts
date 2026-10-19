/**
 * Ingest, process, retry and the webhook handler against an in-memory store that behaves
 * like the database (unique message id, one order per email).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DraftParams } from "@/lib/intake/draft";
import { ingestEmail, processEmail, type IntakeStatus, type IntakeStore, type StoredEmail } from "@/lib/intake/process";
import { tokenMatches, presentedToken } from "@/lib/intake/token";
import type { NormalizedEmail, ParsedEmail } from "@/lib/intake/types";
import { handleIntakeWebhook } from "@/lib/intake/webhook";
import { fakeLlm } from "../fixtures/intake/llm-fakes";
import { fixture, reference } from "../fixtures/intake/reference";
import { ryderEgrReturn, ryderPoIssued } from "../fixtures/intake/templates";

type Row = StoredEmail & { parsed: ParsedEmail | null; error: string | null };

function memoryStore(options: { failDraft?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const drafts: DraftParams[] = [];
  const store: IntakeStore = {
    async insertEmail(email: NormalizedEmail) {
      const existing = [...rows.values()].find((r) => r.email.messageId === email.messageId);
      if (existing) return { id: existing.id, inserted: false, status: existing.status, work_order_id: existing.work_order_id };
      const id = randomUUID();
      rows.set(id, { id, status: "new", work_order_id: null, attempts: 0, email, parsed: null, error: null });
      return { id, inserted: true, status: "new" as IntakeStatus, work_order_id: null };
    },
    async getEmail(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async reference() {
      return reference();
    },
    async saveResult(id, result) {
      const r = rows.get(id)!;
      if (r.work_order_id) return;
      Object.assign(r, result);
    },
    async createDraft(params) {
      if (options.failDraft) throw new Error("No customer price for catalog item");
      const r = rows.get(params.p_email)!;
      if (r.work_order_id) return r.work_order_id; // the database function returns the existing order
      drafts.push(params);
      r.work_order_id = randomUUID();
      r.status = "converted";
      r.error = null;
      return r.work_order_id;
    },
  };
  return { store, rows, drafts };
}

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
