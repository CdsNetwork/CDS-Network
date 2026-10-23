/**
 * Resend inbound adapter for the email intake (route: POST /api/intake/resend).
 *
 * Feed (decision 2026-10-23): CDS's Gmail auto-forwards dispatch@cds.direct to
 * intake@in.cds.direct; Resend receives mail for in.cds.direct (team "CDS Network") and posts
 * an `email.received` webhook. Gmail auto-forwarding keeps the original From, To and Subject.
 *
 * What must be configured (nothing works until all three are set; the route answers 503
 * "not configured" otherwise):
 *   1. Resend dashboard > Webhooks: endpoint https://<portal domain>/api/intake/resend,
 *      event `email.received`.
 *   2. RESEND_WEBHOOK_SECRET: that webhook's signing secret (starts with "whsec_").
 *   3. RESEND_RECEIVING_API_KEY: a Resend API key that can read received emails (full access;
 *      the sending-only key used for outgoing mail cannot).
 *
 * Flow: verify the Svix signature (svix-id, svix-timestamp, svix-signature; HMAC-SHA256 over
 * "<id>.<timestamp>.<raw body>" with the base64 secret after "whsec_"; timestamp within five
 * minutes). The webhook carries metadata only, so the full email is fetched with
 *   GET https://api.resend.com/emails/receiving/{email_id}?html_format=cid
 * and its attachment list with
 *   GET https://api.resend.com/emails/receiving/{email_id}/attachments
 * (shapes per resend.com/docs, 2026-10-23). Only attachment metadata is kept, like every
 * other feed; the temporary download URLs are not stored. The normalized email goes through
 * ingestEmail, so a repeated delivery (same Message-ID) is processed once.
 *
 * Status codes: 503 not configured, 401 bad or old signature, 400 not a usable event, 413 too
 * large, 502 Resend did not return the email and 500 not stored (Resend retries both), 200
 * otherwise.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { emailAddress, validateNormalizedEmail } from "./email";
import type { LlmExtractor } from "./llm";
import { ingestEmail, type IntakeStore } from "./process";
import type { NormalizedEmail } from "./types";
import { MAX_WEBHOOK_BODY, type WebhookResult } from "./webhook";

export const RESEND_API_BASE = "https://api.resend.com";
/** Svix's default tolerance: a signed request older or newer than this is refused. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type ResendConfig = { webhookSecret: string; apiKey: string };

export type ReceivedAttachment = {
  id?: string;
  filename?: string | null;
  content_type?: string | null;
  content_disposition?: string | null;
  content_id?: string | null;
  size?: number | null;
  download_url?: string;
  expires_at?: string;
};

export type ReceivedEmail = {
  id: string;
  from?: string | null;
  to?: string[] | null;
  cc?: string[] | null;
  subject?: string | null;
  created_at?: string | null;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string | string[] | null | undefined> | null;
  message_id?: string | null;
  received_for?: string[] | null;
  attachments?: ReceivedAttachment[] | null;
};

const secretKey = (secret: string): Buffer | null => {
  if (!secret.startsWith("whsec_")) return null;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return key.length >= 16 ? key : null;
};

export function resendIntakeConfig(env: Record<string, string | undefined> = process.env): ResendConfig | null {
  const webhookSecret = env.RESEND_WEBHOOK_SECRET?.trim();
  const apiKey = env.RESEND_RECEIVING_API_KEY?.trim();
  if (!webhookSecret || !apiKey || !secretKey(webhookSecret)) return null;
  return { webhookSecret, apiKey };
}

/** Svix signature check, as Resend documents it (docs.svix.com/receiving/verifying-payloads/how-manual). */
export function verifyResendSignature(
  headers: Headers,
  rawBody: string,
  secret: string,
  nowMs: number,
): { ok: true } | { ok: false; error: string } {
  const id = headers.get("svix-id")?.trim();
  const timestamp = headers.get("svix-timestamp")?.trim();
  const signatures = headers.get("svix-signature")?.trim();
  if (!id || !timestamp || !signatures) return { ok: false, error: "missing signature headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, error: "bad timestamp" };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, error: "timestamp too old or too new" };
  const key = secretKey(secret);
  if (!key) return { ok: false, error: "bad secret" };

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of signatures.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, error: "signature does not match" };
}

class ResendFetchError extends Error {}

async function resendGet<T>(apiKey: string, path: string, fetchImpl: typeof fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${RESEND_API_BASE}/${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ResendFetchError(`Resend could not be reached (${e instanceof Error ? e.message : "network error"})`);
  }
  const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok || !body) throw new ResendFetchError(`Resend answered HTTP ${res.status}${body?.message ? `: ${String(body.message).slice(0, 200)}` : ""}`);
  return body;
}

export function fetchReceivedEmail(apiKey: string, emailId: string, fetchImpl: typeof fetch = fetch): Promise<ReceivedEmail> {
  return resendGet<ReceivedEmail>(apiKey, `emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`, fetchImpl);
}

/** Every attachment of a received email (paged with `after` when Resend says has_more). */
export async function fetchReceivedAttachments(apiKey: string, emailId: string, fetchImpl: typeof fetch = fetch): Promise<ReceivedAttachment[]> {
  const out: ReceivedAttachment[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const path: string = `emails/receiving/${encodeURIComponent(emailId)}/attachments${after ? `?after=${encodeURIComponent(after)}` : ""}`;
    const res = await resendGet<{ data?: ReceivedAttachment[]; has_more?: boolean }>(apiKey, path, fetchImpl);
    const data = Array.isArray(res.data) ? res.data : [];
    out.push(...data);
    const last = data[data.length - 1]?.id;
    if (!res.has_more || !last) break;
    after = last;
  }
  return out;
}

function header(email: ReceivedEmail, name: string): string | null {
  const v = email.headers?.[name] ?? email.headers?.[name.toLowerCase()];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

/**
 * The CDS inbox Gmail forwarded from: Gmail adds "X-Forwarded-For: <forwarding inbox> <target>"
 * when it auto-forwards.
 */
function forwardedFrom(email: ReceivedEmail): string | null {
  const v = header(email, "x-forwarded-for");
  if (!v) return null;
  return (
    v
      .split(/[\s,]+/)
      .map((a) => emailAddress(a))
      .find((a): a is string => !!a && a.endsWith("@cds.direct")) ?? null
  );
}

/** The full received email in the shape every intake feed is converted to. */
export function receivedToNormalized(email: ReceivedEmail, attachments: ReceivedAttachment[]): NormalizedEmail {
  const list = attachments.length ? attachments : (email.attachments ?? []);
  const text = email.text?.trim() ? email.text : null;
  const html = email.html?.trim() ? email.html : null;
  const result = validateNormalizedEmail({
    messageId: email.message_id?.trim() || `resend-${email.id}`,
    // The header keeps the display name ("Jane Doe <jane@x>"); the top level field is the bare address.
    from: header(email, "from") ?? email.from ?? "",
    to: email.to ?? [],
    subject: email.subject ?? "",
    receivedAt: email.created_at ?? undefined,
    text: text ?? (html ? null : "(no body)"),
    html,
    attachments: list.map((a) => ({ filename: a.filename ?? "", contentType: a.content_type ?? null, size: a.size ?? null })),
    inReplyTo: header(email, "in-reply-to"),
    deliveredTo: forwardedFrom(email),
  });
  if (!result.ok) throw new Error(`received email ${email.id}: ${result.error}`);
  return result.value;
}

const EMAIL_ID = /^[A-Za-z0-9-]{8,100}$/;

/** The route's logic without Next.js, so it can be tested with a fake store and fetch. */
export async function handleResendWebhook(
  request: Request,
  deps: { config: ResendConfig | null; store: () => IntakeStore; llm: LlmExtractor | null; fetchImpl?: typeof fetch; now?: () => number },
): Promise<WebhookResult> {
  if (!deps.config) return { status: 503, body: { error: "resend intake is not configured" } };

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_WEBHOOK_BODY) return { status: 413, body: { error: "too large" } };
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BODY) return { status: 413, body: { error: "too large" } };

  const verified = verifyResendSignature(request.headers, raw, deps.config.webhookSecret, (deps.now ?? Date.now)());
  if (!verified.ok) return { status: 401, body: { error: "bad signature" } };

  let event: { type?: unknown; data?: { email_id?: unknown } } | null;
  try {
    event = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "not json" } };
  }
  if (!event || typeof event !== "object") return { status: 400, body: { error: "not an event" } };
  if (event.type !== "email.received") return { status: 200, body: { ok: true, ignored: String(event.type ?? "unknown") } };
  const emailId = event.data?.email_id;
  if (typeof emailId !== "string" || !EMAIL_ID.test(emailId)) return { status: 400, body: { error: "email_id missing" } };

  const fetchImpl = deps.fetchImpl ?? fetch;
  let email: NormalizedEmail;
  try {
    const [received, attachments] = await Promise.all([
      fetchReceivedEmail(deps.config.apiKey, emailId, fetchImpl),
      fetchReceivedAttachments(deps.config.apiKey, emailId, fetchImpl),
    ]);
    email = receivedToNormalized(received, attachments);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.error(`Resend intake: email ${emailId} could not be fetched: ${message}`);
    return { status: 502, body: { error: "email could not be fetched from Resend" } };
  }

  try {
    const outcome = await ingestEmail(deps.store(), email, { source: "webhook", llm: deps.llm });
    return {
      status: 200,
      body: { ok: true, id: outcome.id, duplicate: outcome.duplicate, status: outcome.status, work_order_id: outcome.workOrderId },
    };
  } catch (e) {
    console.error(`Resend intake: email ${emailId} not stored: ${e instanceof Error ? e.message : "unknown error"}`);
    return { status: 500, body: { error: "not stored" } };
  }
}
