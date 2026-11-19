/**
 * Sends the emails to shops (Sarah, CDS, 2026-11-19): run by Vercel cron every 5 minutes
 * (src/app/api/cron/shop-emails/route.ts) and, for one order, right after CDS dispatches it,
 * decides an extra work request or adds a note (src/lib/shop-email-send.ts).
 *
 * 1. Reminders (cron only): the open orders of shops with emails on are checked against the
 *    rules (src/lib/shop-email-reminders.ts); each due reminder is recorded under its fixed key
 *    (public.shop_emails.dedupe_key is unique), so a rerun records and sends nothing new.
 * 2. Every due row (a queued notice, a new reminder, or one that failed fewer than 3 times in
 *    the last day) is claimed atomically and sent as one email to the shop's dispatch contacts,
 *    with the row id as Resend's idempotency key.
 * Nothing is sent, and the row is recorded as skipped with the reason, when the shop's switch
 * is off, the shop is CDS's in-house shop or inactive, the order moved to another shop or no
 * longer waits on what the email is about, the note was deleted, or no contact receives
 * dispatch emails. While PORTAL_EMAILS_ENABLED is not "true" (the portal's email switch, also
 * for the emails to CDS) due rows are recorded as skipped and no reminders are made.
 */
import { portalEmailConfig } from "@/lib/portal-email";
import { buildShopEmail, sendShopEmail, shopRecipients, type ShopContact, type ShopEmailItem, type ShopEmailKind } from "@/lib/shop-email";
import { dueReminders, type ReminderCandidate } from "@/lib/shop-email-reminders";
import { authLinkBase } from "@/lib/shop-login";

export const MAX_ATTEMPTS = 3;
const BATCH = 50;
/** A notice queued more than a day ago and never sent is stale: recorded as skipped. */
const STALE_MS = 24 * 3_600_000;

export type ShopEmailRow = {
  id: number;
  workOrderId: string;
  affiliateId: string;
  kind: ShopEmailKind;
  refId: string | null;
  since: string | null;
  createdAt: string;
  dedupeKey?: string;
};

export type ShopEmailContext = {
  order: {
    id: string;
    woNumber: number | string;
    status: string;
    affiliateId: string | null;
    location: string | null;
    unitNumber: string | null;
    poNumber: string | null;
    fulfillment: string;
  };
  shop: { name: string; emailsEnabled: boolean; inHouse: boolean; active: boolean };
  contacts: ShopContact[];
  /** The note of a note notice, null when it was deleted. */
  note: { author: string; body: string } | null;
  extraWork: ShopEmailItem | null;
  lines: ShopEmailItem[];
};

export type ShopEmailFinish = {
  status: "sent" | "skipped" | "error";
  note?: string | null;
  recipients?: string[];
  subject?: string | null;
  provider_id?: string | null;
  sent_at?: string | null;
};

export type NewReminder = {
  workOrderId: string;
  affiliateId: string;
  kind: ShopEmailKind;
  dedupeKey: string;
  since: string;
  status: "pending" | "skipped";
  note?: string | null;
};

/** Storage behind the run (src/lib/shop-email-store.ts is the database one). */
export type ShopEmailStore = {
  reminderCandidates(workOrderIds?: string[]): Promise<ReminderCandidate[]>;
  /** Records reminders; a key that exists already is left as it is. */
  recordReminders(rows: NewReminder[]): Promise<void>;
  /** Rows to send now: pending, failed or abandoned ones that may be tried again. */
  dueRows(nowIso: string, workOrderIds: string[] | undefined, limit: number): Promise<ShopEmailRow[]>;
  /** Takes the row for sending; false when another run has it or it is not due. */
  claim(id: number): Promise<boolean>;
  context(row: ShopEmailRow): Promise<ShopEmailContext | null>;
  finish(id: number, patch: ShopEmailFinish): Promise<void>;
  /** Emails are off: records every due pending row as skipped; returns how many. */
  skipDue(note: string, nowIso: string, workOrderIds?: string[]): Promise<number>;
};

export type ShopEmailSummary = { reminders: number; sent: number; skipped: number; failed: number };

const WAITING: Record<ShopEmailKind, string[]> = {
  dispatch: ["awaiting_acceptance"],
  not_accepted: ["awaiting_acceptance"],
  lines: ["awaiting_acceptance", "accepted", "picked_up", "in_process"],
  no_update: ["accepted", "picked_up", "in_process"],
  not_completed: ["accepted", "picked_up", "in_process"],
  note: ["awaiting_acceptance", "accepted", "picked_up", "in_process", "completed"],
  extra_work_approved: ["awaiting_acceptance", "accepted", "picked_up", "in_process", "completed"],
  extra_work_declined: ["awaiting_acceptance", "accepted", "picked_up", "in_process", "completed"],
};

/** Why this email must not go out, or null when it may. */
export function skipReason(row: ShopEmailRow, ctx: ShopEmailContext | null): string | null {
  if (!ctx) return "Not sent: the work order is gone.";
  if (ctx.shop.inHouse) return "Not sent: CDS's in-house shop is never emailed.";
  if (!ctx.shop.emailsEnabled) return "Not sent: emails to this shop are turned off.";
  if (!ctx.shop.active) return "Not sent: the shop is inactive.";
  if (ctx.order.affiliateId !== row.affiliateId) return "Not sent: the order moved to another shop.";
  if (!WAITING[row.kind].includes(ctx.order.status)) return `Not sent: the order is no longer at that step (now ${ctx.order.status}).`;
  if (row.kind === "note" && !ctx.note) return "Not sent: the note was deleted.";
  if (!shopRecipients(ctx.contacts).length) return "Not sent: no contact of this shop is marked to receive dispatch emails.";
  return null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runShopEmails(
  store: ShopEmailStore,
  deps: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    now?: () => number;
    /** Stop starting new emails after this many milliseconds. */
    budgetMs?: number;
    /** Only these work orders (the kick after a CDS change, tests). */
    workOrderIds?: string[];
    /** Make due reminders first (default true). */
    reminders?: boolean;
  } = {},
): Promise<ShopEmailSummary> {
  const summary: ShopEmailSummary = { reminders: 0, sent: 0, skipped: 0, failed: 0 };
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const started = now();
  const nowIso = new Date(started).toISOString();
  const config = portalEmailConfig(env);

  if (!config.enabled) {
    summary.skipped = await store.skipDue("Not sent: PORTAL_EMAILS_ENABLED is not true.", nowIso, deps.workOrderIds);
    return summary;
  }

  if (deps.reminders !== false) {
    const candidates = await store.reminderCandidates(deps.workOrderIds);
    const fresh: NewReminder[] = [];
    for (const c of candidates) {
      for (const r of dueReminders(c, started)) {
        fresh.push({
          workOrderId: c.workOrderId,
          affiliateId: c.affiliateId,
          kind: r.kind,
          dedupeKey: r.key,
          since: r.since,
          status: r.covered ? "skipped" : "pending",
          note: r.covered ? "Not sent: the not completed reminder sent at the same time covers it." : null,
        });
      }
    }
    if (fresh.length) await store.recordReminders(fresh);
    summary.reminders = fresh.filter((r) => r.status === "pending").length;
  }

  const base = authLinkBase(env);
  const budget = deps.budgetMs ?? 45_000;
  const rows = await store.dueRows(nowIso, deps.workOrderIds, BATCH);
  for (const row of rows) {
    if (now() - started > budget) break;
    if (!(await store.claim(row.id))) continue;
    try {
      if (started - Date.parse(row.createdAt) > STALE_MS) {
        await store.finish(row.id, { status: "skipped", note: "Not sent: queued more than a day ago." });
        summary.skipped += 1;
        continue;
      }
      const ctx = await store.context(row);
      const reason = skipReason(row, ctx);
      if (reason || !ctx) {
        await store.finish(row.id, { status: "skipped", note: reason });
        summary.skipped += 1;
        continue;
      }
      if (!config.apiKey) {
        await store.finish(row.id, { status: "error", note: "Not sent: neither RESEND_SEND_API_KEY nor RESEND_RECEIVING_API_KEY is set." });
        summary.failed += 1;
        continue;
      }
      const to = shopRecipients(ctx.contacts);
      const email = buildShopEmail(
        row.kind,
        {
          workOrderId: ctx.order.id,
          woNumber: ctx.order.woNumber,
          shopName: ctx.shop.name,
          location: ctx.order.location,
          unitNumber: ctx.order.unitNumber,
          poNumber: ctx.order.poNumber,
          fulfillment: ctx.order.fulfillment,
          lines: ctx.lines,
          note: ctx.note,
          extraWork: ctx.extraWork,
          since: row.since,
        },
        base,
      );
      const id = await sendShopEmail(config.apiKey, to, email, `shop-email-${row.id}`, deps.fetchImpl ?? fetch);
      await store.finish(row.id, { status: "sent", recipients: to, subject: email.subject, provider_id: id, note: null, sent_at: new Date(now()).toISOString() });
      summary.sent += 1;
    } catch (e) {
      const message = errorText(e).slice(0, 2000);
      console.error(`Shop email ${row.id} (${row.kind}, work order ${row.workOrderId}): ${message}`);
      await store.finish(row.id, { status: "error", note: message }).catch((err) => console.error(`Shop email ${row.id}: could not record the error: ${errorText(err)}`));
      summary.failed += 1;
    }
  }
  return summary;
}
