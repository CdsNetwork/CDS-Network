/**
 * Status emails to CDS's dispatch inbox (CDS, 2026-11-04): when a work order is sent to a
 * shop, declined by a shop, or finished by a shop (Complete Work), the portal emails
 * dispatch@cds.direct. CDS only: shops get no email from the portal. A shop marking a component
 * failed or condemned also emails dispatch@ (Ashley, 2026-11-11), once per failure
 * (component_failures, 20261111040000_shop_updates.sql).
 *
 * Sent through Resend (POST https://api.resend.com/emails) from CDS Portal
 * <portal@in.cds.direct>; in.cds.direct is verified in Resend for sending. Every subject starts
 * with "[Portal] ". dispatch@ forwards every email into the intake, which ignores these by
 * their sender (src/lib/intake/ignore.ts, portalEmailRule).
 *
 * Settings (server only):
 *   PORTAL_EMAILS_ENABLED  must be "true" to send; otherwise each change is recorded as skipped.
 *   PORTAL_EMAILS_TO       optional, comma separated; defaults to dispatch@cds.direct.
 *   RESEND_SEND_API_KEY    Resend key that can send; falls back to RESEND_RECEIVING_API_KEY.
 *
 * Each status change is one integration_sync row (system 'email', entity 'portal_email',
 * entity_id the work order, external_id the change's key), claimed before sending, so a retry
 * or a double click emails once. The row ends as ok (the note holds Resend's email id),
 * skipped, error or duplicate. Nothing here ever throws into the status change: it already
 * happened, and an email failure is logged and recorded only.
 */
import { dateTime } from "@/lib/format";

export type PortalEvent = "sent" | "declined" | "finished" | "failed";

export const PORTAL_FROM = "CDS Portal <portal@in.cds.direct>";
/** The portal's own sending domain: mail from it is never a request. */
export const PORTAL_DOMAIN = "in.cds.direct";
export const PORTAL_SUBJECT_PREFIX = "[Portal] ";
export const PORTAL_BASE_URL = "https://cds-network-portal.vercel.app";
export const DEFAULT_PORTAL_EMAILS_TO = ["dispatch@cds.direct"];
const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export type PortalEmailDetails = {
  workOrderId: string;
  woNumber: number | string;
  customer: string | null;
  location: string | null;
  unitNumber: string | null;
  poNumber: string | null;
  shop: string | null;
  /** When the status changed (the work order event's time). */
  at: string;
  declineReason: string | null;
  /** The shop's invoice or reference number given on Complete Work. */
  shopReference: string | null;
  /** Failure emails only: the component ("DPF, part 2871891, serial SN-4471"), its result and the shop's reason. */
  component?: string | null;
  result?: string | null;
  failureNote?: string | null;
};

const VERB: Record<PortalEvent, { subject: string; sentence: string }> = {
  sent: { subject: "sent to", sentence: "was sent to" },
  declined: { subject: "declined by", sentence: "was declined by" },
  finished: { subject: "finished by", sentence: "was finished by" },
  failed: { subject: "marked failed by", sentence: "was marked failed by" },
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function workOrderUrl(workOrderId: string): string {
  return `${PORTAL_BASE_URL}/cds/work-orders/${workOrderId}`;
}

export function buildPortalEmail(event: PortalEvent, d: PortalEmailDetails): { subject: string; text: string; html: string } {
  const shop = d.shop?.trim() || "a shop";
  const wo = `WO ${d.woNumber}`;
  const failed = event === "failed";
  const result = d.result?.trim() || "Failed";
  const componentType = d.component?.split(",")[0]?.trim() || "Component";
  const subject = failed
    ? `${PORTAL_SUBJECT_PREFIX}${wo} ${componentType} marked ${result} by ${shop}`
    : `${PORTAL_SUBJECT_PREFIX}${wo} ${VERB[event].subject} ${shop}`;
  const headline = failed ? `A component on ${wo} was marked ${result} by ${shop}.` : `${wo} ${VERB[event].sentence} ${shop}.`;
  const rows: [string, string | null][] = [
    ["Work order", wo],
    ["Customer", d.customer],
    ["Location", d.location],
    ["Unit", d.unitNumber],
    ["PO", d.poNumber],
    ["Shop", d.shop],
    ["When", dateTime(d.at)],
    ["Decline reason", event === "declined" ? d.declineReason : null],
    ["Shop invoice / reference", event === "finished" ? d.shopReference : null],
    ["Component", failed ? (d.component ?? null) : null],
    ["Result", failed ? result : null],
    ["Reason", failed ? (d.failureNote ?? null) : null],
  ];
  const shown = rows.filter((r): r is [string, string] => !!r[1]?.trim());
  const url = workOrderUrl(d.workOrderId);
  const footer = "Sent automatically by the CDS Network Portal.";

  const text = [headline, "", ...shown.map(([k, v]) => `${k}: ${v.trim()}`), "", `Open the work order: ${url}`, "", footer, ""].join("\n");
  const html = [
    `<p>${escapeHtml(headline)}</p>`,
    `<table cellpadding="4" cellspacing="0" style="border-collapse:collapse">`,
    ...shown.map(([k, v]) => `<tr><td style="color:#555">${escapeHtml(k)}</td><td>${escapeHtml(v.trim())}</td></tr>`),
    `</table>`,
    `<p><a href="${escapeHtml(url)}">Open the work order</a></p>`,
    `<p style="color:#777;font-size:12px">${escapeHtml(footer)}</p>`,
  ].join("\n");
  return { subject, text, html };
}

export type PortalEmailConfig = { enabled: boolean; apiKey: string | null; to: string[] };

export function portalEmailConfig(env: Record<string, string | undefined> = process.env): PortalEmailConfig {
  const to = (env.PORTAL_EMAILS_TO ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return {
    enabled: env.PORTAL_EMAILS_ENABLED === "true",
    apiKey: env.RESEND_SEND_API_KEY?.trim() || env.RESEND_RECEIVING_API_KEY?.trim() || null,
    to: to.length ? to : DEFAULT_PORTAL_EMAILS_TO,
  };
}

/** Storage behind the emails (src/lib/portal-email-store.ts is the database one). */
export type PortalEmailStore = {
  /**
   * The work order and its latest status change of this kind, with the change's key (the same
   * for a repeated or double clicked change), or null when either is not found. For "failed",
   * componentId names the component and the change is its latest failure.
   */
  details(
    event: PortalEvent,
    workOrderId: string,
    componentId?: string,
  ): Promise<(PortalEmailDetails & { key: string }) | null>;
  /** Claims the key for this work order; null when it was claimed before (already emailed). */
  claim(event: PortalEvent, workOrderId: string, key: string): Promise<{ rowId: number } | null>;
  finish(rowId: number, status: "ok" | "skipped" | "error", note: string | null): Promise<void>;
};

export type NotifyResult = { status: "ok" | "skipped" | "error" | "duplicate"; message: string };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function sendWithResend(
  config: PortalEmailConfig & { apiKey: string },
  email: { subject: string; text: string; html: string },
  idempotencyKey: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // Resend answers a repeated key (within 24 hours) with the first email instead of a second.
        "Idempotency-Key": idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({ from: PORTAL_FROM, to: config.to, subject: email.subject, text: email.text, html: email.html }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`Resend could not be reached (${errorText(e)})`);
  }
  const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!res.ok || !body?.id) {
    throw new Error(`Resend answered HTTP ${res.status}${body?.message ? `: ${String(body.message).slice(0, 300)}` : ""}`);
  }
  return body.id;
}

/**
 * Emails CDS about one status change that already happened. Never throws: every outcome is
 * returned, logged when it failed, and recorded in integration_sync when the change was found.
 */
export async function notifyWorkOrderEvent(
  event: PortalEvent,
  workOrderId: string,
  deps: {
    store: PortalEmailStore;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    /** "failed" only: the component the shop marked failed or condemned. */
    componentId?: string;
  },
): Promise<NotifyResult> {
  const fail = (message: string): NotifyResult => {
    console.error(`Portal email (${event}, work order ${workOrderId}): ${message}`);
    return { status: "error", message };
  };
  let rowId: number | null = null;
  try {
    const found = deps.componentId
      ? await deps.store.details(event, workOrderId, deps.componentId)
      : await deps.store.details(event, workOrderId);
    if (!found) return fail("work order or its status change not found; nothing sent");
    const { key, ...details } = found;

    const claim = await deps.store.claim(event, workOrderId, key);
    if (!claim) return { status: "duplicate", message: "This status change was already emailed." };
    rowId = claim.rowId;

    const config = portalEmailConfig(deps.env ?? process.env);
    if (!config.enabled) {
      await deps.store.finish(rowId, "skipped", "Not sent: PORTAL_EMAILS_ENABLED is not true.");
      return { status: "skipped", message: "Portal emails are turned off." };
    }
    if (!config.apiKey) {
      const message = "Not sent: neither RESEND_SEND_API_KEY nor RESEND_RECEIVING_API_KEY is set.";
      await deps.store.finish(rowId, "error", message);
      return fail(message);
    }

    const email = buildPortalEmail(event, details);
    const id = await sendWithResend({ ...config, apiKey: config.apiKey }, email, `portal-${workOrderId}-${key}`, deps.fetchImpl ?? fetch);
    await deps.store.finish(rowId, "ok", `Resend email ${id} to ${config.to.join(", ")}`);
    return { status: "ok", message: id };
  } catch (e) {
    const message = errorText(e).slice(0, 2000);
    if (rowId !== null) {
      await deps.store.finish(rowId, "error", message).catch((err) => console.error(`Portal email: could not record the error: ${errorText(err)}`));
    }
    return fail(message);
  }
}
