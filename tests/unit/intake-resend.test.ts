/**
 * The Resend inbound adapter (POST /api/intake/resend): verifies Resend's (Svix) signature,
 * fetches the full email and its attachment list from the Received Emails API, and hands the
 * normalized email to the existing intake pipeline. Fixtures follow the shapes in Resend's
 * docs (webhooks/emails/received, api-reference retrieve received email and list attachments).
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  handleResendWebhook,
  receivedToNormalized,
  resendIntakeConfig,
  verifyResendSignature,
  type ReceivedAttachment,
  type ReceivedEmail,
} from "@/lib/intake/resend";
import { fakeLlm } from "../fixtures/intake/llm-fakes";
import { memoryStore } from "../fixtures/intake/memory-store";

const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/intake/resend/${name}.json`, import.meta.url), "utf8"));

const SECRET_BYTES = randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const API_KEY = "re_test_receiving_key_for_unit_tests";
const NOW = Date.parse("2026-10-23T14:05:05Z");

function sign(body: string, id: string, timestamp: number, key: Buffer = SECRET_BYTES): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function post(body: unknown, opts: { id?: string; timestamp?: number; signature?: string | null } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const id = opts.id ?? "msg_2Kx0abc";
  const timestamp = opts.timestamp ?? Math.floor(NOW / 1000);
  const headers: Record<string, string> = { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp) };
  const signature = opts.signature === undefined ? sign(raw, id, timestamp) : opts.signature;
  if (signature !== null) headers["svix-signature"] = signature;
  return new Request("https://portal.example/api/intake/resend", { method: "POST", headers, body: raw });
}

/** A fake fetch for api.resend.com that answers from the fixtures and records each call. */
function fakeResend(email: ReceivedEmail = load("received-email"), attachments = load("received-attachments")) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url.startsWith(`https://api.resend.com/emails/receiving/${email.id}/attachments`)) return Response.json(attachments);
    if (url.startsWith(`https://api.resend.com/emails/receiving/${email.id}`)) return Response.json(email);
    return Response.json({ name: "not_found", message: "Email not found" }, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const config = { webhookSecret: SECRET, apiKey: API_KEY };

describe("resendIntakeConfig", () => {
  it("needs both the webhook secret (whsec_ format) and the receiving API key", () => {
    expect(resendIntakeConfig({ RESEND_WEBHOOK_SECRET: SECRET, RESEND_RECEIVING_API_KEY: API_KEY })).toEqual(config);
    expect(resendIntakeConfig({ RESEND_WEBHOOK_SECRET: SECRET })).toBeNull();
    expect(resendIntakeConfig({ RESEND_RECEIVING_API_KEY: API_KEY })).toBeNull();
    expect(resendIntakeConfig({ RESEND_WEBHOOK_SECRET: "not-a-secret", RESEND_RECEIVING_API_KEY: API_KEY })).toBeNull();
  });
});

describe("verifyResendSignature", () => {
  const body = JSON.stringify(load("received-webhook"));
  const headers = (h: Record<string, string>) => new Headers(h);
  const ts = Math.floor(NOW / 1000);

  it("accepts a valid signature, also among several (secret rotation)", () => {
    expect(verifyResendSignature(headers({ "svix-id": "m1", "svix-timestamp": String(ts), "svix-signature": sign(body, "m1", ts) }), body, SECRET, NOW)).toEqual({ ok: true });
    const several = `v1,${Buffer.from("old").toString("base64")} ${sign(body, "m1", ts)}`;
    expect(verifyResendSignature(headers({ "svix-id": "m1", "svix-timestamp": String(ts), "svix-signature": several }), body, SECRET, NOW)).toEqual({ ok: true });
  });

  it("refuses a missing, wrong or tampered signature", () => {
    expect(verifyResendSignature(headers({ "svix-id": "m1", "svix-timestamp": String(ts) }), body, SECRET, NOW).ok).toBe(false);
    const other = sign(body, "m1", ts, randomBytes(24));
    expect(verifyResendSignature(headers({ "svix-id": "m1", "svix-timestamp": String(ts), "svix-signature": other }), body, SECRET, NOW).ok).toBe(false);
    const good = sign(body, "m1", ts);
    expect(verifyResendSignature(headers({ "svix-id": "m1", "svix-timestamp": String(ts), "svix-signature": good }), `${body} `, SECRET, NOW).ok).toBe(false);
    expect(verifyResendSignature(headers({ "svix-id": "m2", "svix-timestamp": String(ts), "svix-signature": good }), body, SECRET, NOW).ok).toBe(false);
  });

  it("refuses a timestamp more than five minutes away", () => {
    const old = ts - 6 * 60;
    expect(verifyResendSignature(headers({ "svix-id": "m1", "svix-timestamp": String(old), "svix-signature": sign(body, "m1", old) }), body, SECRET, NOW)).toEqual({
      ok: false,
      error: "timestamp too old or too new",
    });
    const future = ts + 6 * 60;
    expect(verifyResendSignature(headers({ "svix-id": "m1", "svix-timestamp": String(future), "svix-signature": sign(body, "m1", future) }), body, SECRET, NOW).ok).toBe(false);
    expect(verifyResendSignature(headers({ "svix-id": "m1", "svix-timestamp": "soon", "svix-signature": sign(body, "m1", ts) }), body, SECRET, NOW).ok).toBe(false);
  });
});

describe("receivedToNormalized", () => {
  it("keeps the display name From, the original subject, the body and the attachments", () => {
    const n = receivedToNormalized(load("received-email"), load("received-attachments").data as ReceivedAttachment[]);
    expect(n).toMatchObject({
      messageId: "<CAF-ryder-0424-0001@mail.ryder.example>",
      from: "Marcus Delgado <mdelgado@ryder.example>",
      to: ["dispatch@cds.direct"],
      subject: "DPF and DOC cleaning request - Location 0424 - Unit 284113",
      receivedAt: "2026-10-23T14:05:02.674Z",
      deliveredTo: "dispatch@cds.direct",
      attachments: [{ filename: "unit-284113-dpf-tag.jpg", contentType: "image/jpeg", size: 184220 }],
    });
    expect(n.text).toContain("VIN: 3AKJHHDR0KSKA7731");
    expect(n.html).toContain("Please schedule a pickup.");
  });

  it("falls back to the Resend id, the bare From and the email's own attachment list", () => {
    const email = { ...load("received-email"), message_id: null, headers: {}, text: null, html: null };
    const n = receivedToNormalized(email, []);
    expect(n.messageId).toBe("resend-4ef9a417-02e9-4d39-ad75-9611e0fcc33c");
    expect(n.from).toBe("mdelgado@ryder.example");
    expect(n.text).toBe("(no body)");
    expect(n.attachments).toEqual([{ filename: "unit-284113-dpf-tag.jpg", contentType: "image/jpeg", size: 184220 }]);
    expect(n.deliveredTo).toBeUndefined();
  });

  it("reads In-Reply-To so replies on a thread stay ignored", () => {
    const email = { ...load("received-email"), headers: { ...load("received-email").headers, "in-reply-to": "<abc@cds.direct>" } };
    expect(receivedToNormalized(email, []).inReplyTo).toBe("<abc@cds.direct>");
  });
});

describe("handleResendWebhook", () => {
  const webhook = load("received-webhook");

  it("answers 503 when not configured, before reading anything", async () => {
    const { store, rows } = memoryStore();
    const { fetchImpl } = fakeResend();
    const r = await handleResendWebhook(post(webhook), { config: null, store: () => store, llm: null, fetchImpl, now: () => NOW });
    expect(r).toEqual({ status: 503, body: { error: "resend intake is not configured" } });
    expect(rows.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses unsigned, badly signed and expired requests without fetching or storing", async () => {
    const { store, rows } = memoryStore();
    const { fetchImpl } = fakeResend();
    const deps = { config, store: () => store, llm: null, fetchImpl, now: () => NOW };
    expect((await handleResendWebhook(post(webhook, { signature: null }), deps)).status).toBe(401);
    expect((await handleResendWebhook(post(webhook, { signature: "v1,AAAA" }), deps)).status).toBe(401);
    expect((await handleResendWebhook(post(webhook, { timestamp: Math.floor(NOW / 1000) - 3600 }), deps)).status).toBe(401);
    expect(rows.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches the full email and its attachments with the receiving key and creates the draft", async () => {
    const { store, rows, drafts } = memoryStore();
    const { fetchImpl, calls } = fakeResend();
    const r = await handleResendWebhook(post(webhook), { config, store: () => store, llm: fakeLlm(), fetchImpl, now: () => NOW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false, status: "converted" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.resend.com/emails/receiving/4ef9a417-02e9-4d39-ad75-9611e0fcc33c?html_format=cid",
      "https://api.resend.com/emails/receiving/4ef9a417-02e9-4d39-ad75-9611e0fcc33c/attachments",
    ]);
    expect(calls.every((c) => c.auth === `Bearer ${API_KEY}`)).toBe(true);
    const stored = [...rows.values()][0];
    expect(stored.email.from).toBe("Marcus Delgado <mdelgado@ryder.example>");
    expect(stored.email.attachments).toEqual([{ filename: "unit-284113-dpf-tag.jpg", contentType: "image/jpeg", size: 184220 }]);
    expect(drafts).toHaveLength(1);
  });

  it("processes a repeated delivery once (same message id)", async () => {
    const { store, rows, drafts } = memoryStore();
    const { fetchImpl } = fakeResend();
    const deps = { config, store: () => store, llm: fakeLlm(), fetchImpl, now: () => NOW };
    await handleResendWebhook(post(webhook), deps);
    const again = await handleResendWebhook(post(webhook, { id: "msg_retry" }), deps);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, duplicate: true });
    expect(rows.size).toBe(1);
    expect(drafts).toHaveLength(1);
  });

  it("stores the Gmail forwarding confirmation as Ignored with its code, without the AI", async () => {
    const { store, rows, drafts } = memoryStore();
    const confirmation = load("gmail-forwarding-confirmation");
    const { fetchImpl } = fakeResend(confirmation, { object: "list", has_more: false, data: [] });
    const llm = vi.fn(fakeLlm());
    const body = { ...webhook, data: { ...webhook.data, email_id: confirmation.id, from: confirmation.from, subject: confirmation.subject, attachments: [] } };
    const r = await handleResendWebhook(post(body), { config, store: () => store, llm, fetchImpl, now: () => NOW });
    expect(r.body).toMatchObject({ ok: true, status: "ignored" });
    expect(llm).not.toHaveBeenCalled();
    expect(drafts).toHaveLength(0);
    const row = [...rows.values()][0];
    expect(row.parsed?.ignore_kind).toBe("forwarding_confirmation");
    expect(row.parsed?.ignore_reason).toContain("715228935");
    expect(row.parsed?.ignore_reason).toContain("dispatch@cds.direct");
  });

  it("acknowledges other event types without fetching", async () => {
    const { store } = memoryStore();
    const { fetchImpl } = fakeResend();
    const r = await handleResendWebhook(post({ type: "email.delivered", created_at: "x", data: {} }), { config, store: () => store, llm: null, fetchImpl, now: () => NOW });
    expect(r).toEqual({ status: 200, body: { ok: true, ignored: "email.delivered" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers 502 when Resend cannot return the email, so Resend delivers the webhook again", async () => {
    const { store, rows } = memoryStore();
    const { fetchImpl } = fakeResend();
    const body = { ...webhook, data: { ...webhook.data, email_id: "00000000-0000-4000-8000-000000000000" } };
    const r = await handleResendWebhook(post(body), { config, store: () => store, llm: null, fetchImpl, now: () => NOW });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain(API_KEY);
    expect(rows.size).toBe(0);
  });

  it("refuses a signed body that is not an email.received event with an email id", async () => {
    const { store } = memoryStore();
    const { fetchImpl } = fakeResend();
    const deps = { config, store: () => store, llm: null, fetchImpl, now: () => NOW };
    expect((await handleResendWebhook(post("not json"), deps)).status).toBe(400);
    expect((await handleResendWebhook(post({ type: "email.received", data: { email_id: "../x" } }), deps)).status).toBe(400);
  });
});

describe("route", () => {
  it("is reachable without a login session (the signature is the check)", async () => {
    vi.doMock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));
    const { PUBLIC_PATHS } = await import("@/proxy");
    expect(PUBLIC_PATHS.some((p) => "/api/intake/resend".startsWith(p))).toBe(true);
  });
});
