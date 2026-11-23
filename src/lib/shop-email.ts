/**
 * Emails to shops (Sarah, CDS, 2026-11-19): notices when CDS does something on a shop's job,
 * and reminders when a job waits on the shop. Content and recipients only; the sending run is
 * src/lib/shop-email-run.ts, the database side src/lib/shop-email-store.ts, the queue and the
 * per-shop switch 20261120200000_shop_emails.sql.
 *
 * Recipients: every contact of the shop marked "receives dispatch" (public.affiliate_contacts),
 * all in To of one email. They are the same shop's own addresses (the shop's locations of one
 * company see each other's anyway), one email keeps one Resend call and one idempotency key per
 * notice, and Resend allows 50 recipients per email (a shop has at most a handful).
 *
 * Content: what the shop already sees on its job page and nothing more: the shop, the WO
 * number, location, unit, PO, the customer's part number and manufacturer, what happened, the services and parts by name and quantity,
 * and a link to the job. Never prices, rates, margins, CDS-only fields or CDS internal notes:
 * the details given here have no such fields at all.
 */
import { dateTime, woLabel } from "@/lib/format";
import { PORTAL_FROM, PORTAL_SUBJECT_PREFIX } from "@/lib/portal-email";
import { authLinkBase, EMAIL_PATTERN, isInternalLoginEmail } from "@/lib/shop-login";

export type ShopEmailKind =
  | "dispatch"
  | "extra_work_approved"
  | "extra_work_declined"
  | "note"
  | "lines"
  | "not_accepted"
  | "no_update"
  | "not_completed";

export const SHOP_EMAIL_KIND_LABEL: Record<ShopEmailKind, string> = {
  dispatch: "New job",
  extra_work_approved: "Extra work approved",
  extra_work_declined: "Extra work declined",
  note: "CDS note",
  lines: "Services or parts changed",
  not_accepted: "Reminder: not accepted",
  no_update: "Reminder: no update",
  not_completed: "Reminder: not completed",
};

export type ShopEmailItem = { item: string; qty: number };

export type ShopEmailDetails = {
  workOrderId: string;
  woNumber: number | string;
  shopName: string;
  location: string | null;
  unitNumber: string | null;
  poNumber: string | null;
  /** The customer's part number on the order (Part # on the shop's job page). */
  partNumber?: string | null;
  /** The manufacturer the customer's request named ("Manufacturer (customer)" on the job page). */
  manufacturer?: string | null;
  fulfillment: string;
  /** The order's services and parts as the shop sees them (no prices). */
  lines: ShopEmailItem[];
  note: { author: string; body: string } | null;
  extraWork: ShopEmailItem | null;
  /** Reminders: when the reminder's clock started. */
  since: string | null;
};

export type ShopContact = { email: string; receivesDispatch: boolean };

const MAX_RECIPIENTS = 50;
const NOTE_LIMIT = 2000;
const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/** The job on the shop's own page (same host rule as the password emails). */
export function shopJobUrl(workOrderId: string, base: string = authLinkBase()): string {
  return `${base}/shop?job=${workOrderId}`;
}

/** The deliverable dispatch addresses of a shop, lower case, once each. */
export function shopRecipients(contacts: ShopContact[]): string[] {
  const out: string[] = [];
  for (const c of contacts) {
    if (!c.receivesDispatch) continue;
    const email = c.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || isInternalLoginEmail(email) || out.includes(email)) continue;
    out.push(email);
  }
  return out.slice(0, MAX_RECIPIENTS);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const qtyText = (n: number) => String(Number.isInteger(n) ? n : Number(n.toFixed(2)));
const itemText = (i: ShopEmailItem) => `${i.item} x ${qtyText(i.qty)}`;

/** Subject, opening sentences and the extra block of each kind. */
function wording(kind: ShopEmailKind, d: ShopEmailDetails): { subject: string; lead: string[]; block: { title: string; lines: string[] } | null } {
  const wo = woLabel(d.woNumber);
  const since = dateTime(d.since);
  const lines = d.lines.length ? { title: "Services and parts", lines: d.lines.map(itemText) } : null;
  const extra = d.extraWork ? itemText(d.extraWork) : "the requested work";
  switch (kind) {
    case "dispatch":
      return { subject: `${wo} new job from CDS`, lead: [`CDS sent you a new job: ${wo}.`, "Please accept or decline it in the portal."], block: lines };
    case "extra_work_approved":
      return { subject: `${wo} extra work approved`, lead: [`CDS approved your extra work request on ${wo}: ${extra}.`, "It is now part of the job."], block: null };
    case "extra_work_declined":
      return { subject: `${wo} extra work declined`, lead: [`CDS declined your extra work request on ${wo}: ${extra}.`, "Open the job for details."], block: null };
    case "note":
      return {
        subject: `${wo} new note from CDS`,
        lead: [`${d.note?.author?.trim() || "CDS"} added a note on ${wo}:`],
        block: { title: "Note", lines: [(d.note?.body ?? "").slice(0, NOTE_LIMIT)] },
      };
    case "lines":
      return { subject: `${wo} services or parts changed by CDS`, lead: [`CDS changed the services or parts on ${wo}.`, "The job now has:"], block: lines };
    case "not_accepted":
      return {
        subject: `${wo} reminder: please accept or decline`,
        lead: [`Reminder: ${wo} was sent to you on ${since} and is not accepted yet.`, "Please accept or decline it in the portal."],
        block: null,
      };
    case "no_update":
      return {
        subject: `${wo} reminder: please update the job`,
        lead: [`Reminder: there has been no update on ${wo} since ${since}.`, "Please update the job in the portal (status, a note or photos)."],
        block: null,
      };
    case "not_completed":
      return {
        subject: `${wo} reminder: job not completed yet`,
        lead: [
          d.fulfillment === "pickup"
            ? `Reminder: ${wo} is not completed yet. You accepted it on ${since}.`
            : `Reminder: ${wo} is not completed yet. The part arrived on ${since}.`,
          "Please complete it in the portal, or add a note on when it will be done.",
        ],
        block: null,
      };
  }
}

export function buildShopEmail(
  kind: ShopEmailKind,
  d: ShopEmailDetails,
  base: string = authLinkBase(),
): { subject: string; text: string; html: string } {
  const w = wording(kind, d);
  const rows: [string, string | null][] = [
    ["Shop", d.shopName],
    ["Work order", woLabel(d.woNumber)],
    ["Location", d.location],
    ["Unit", d.unitNumber],
    ["PO", d.poNumber],
    ["Part #", d.partNumber ?? null],
    ["Manufacturer (customer)", d.manufacturer ?? null],
  ];
  const shown = rows.filter((r): r is [string, string] => !!r[1]?.trim());
  const url = shopJobUrl(d.workOrderId, base);
  const footer = "Sent automatically by the CDS Network Portal. Please do not reply to this email: add a note on the job in the portal instead.";
  const greeting = `Hello ${d.shopName},`;

  const text = [
    greeting,
    "",
    ...w.lead,
    "",
    ...(w.block ? [`${w.block.title}:`, ...w.block.lines.map((l) => (w.block!.title === "Note" ? l : `- ${l}`)), ""] : []),
    ...shown.map(([k, v]) => `${k}: ${v.trim()}`),
    "",
    `Open the job: ${url}`,
    "",
    footer,
    "",
  ].join("\n");

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${w.lead.map(escapeHtml).join("<br>")}</p>`,
    ...(w.block
      ? w.block.title === "Note"
        ? [`<blockquote style="margin:0 0 12px;padding-left:10px;border-left:3px solid #ccc;white-space:pre-wrap">${escapeHtml(w.block.lines[0])}</blockquote>`]
        : [`<p style="margin-bottom:4px"><b>${escapeHtml(w.block.title)}</b></p>`, `<ul style="margin-top:0">${w.block.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`]
      : []),
    `<table cellpadding="4" cellspacing="0" style="border-collapse:collapse">`,
    ...shown.map(([k, v]) => `<tr><td style="color:#555">${escapeHtml(k)}</td><td>${escapeHtml(v.trim())}</td></tr>`),
    `</table>`,
    `<p><a href="${escapeHtml(url)}">Open the job</a></p>`,
    `<p style="color:#777;font-size:12px">${escapeHtml(footer)}</p>`,
  ].join("\n");

  return { subject: `${PORTAL_SUBJECT_PREFIX}${w.subject}`, text, html };
}

/** Sends one email through Resend and returns Resend's email id; throws on any failure. */
export async function sendShopEmail(
  apiKey: string,
  to: string[],
  email: { subject: string; text: string; html: string },
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Resend answers a repeated key (within 24 hours) with the first email instead of a second.
        "Idempotency-Key": idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({ from: PORTAL_FROM, to, subject: email.subject, text: email.text, html: email.html }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`Resend could not be reached (${e instanceof Error ? e.message : String(e)})`);
  }
  const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!res.ok || !body?.id) {
    throw new Error(`Resend answered HTTP ${res.status}${body?.message ? `: ${String(body.message).slice(0, 300)}` : ""}`);
  }
  return body.id;
}
