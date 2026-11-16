/**
 * Retries status emails to CDS that failed (review 2026-11-16, M4). Run by Vercel cron
 * (src/app/api/cron/portal-email-retry/route.ts).
 *
 * Picks the claim rows (integration_sync, system 'email', entity 'portal_email') that ended in
 * error or were abandoned while sending, younger than 24 hours and tried fewer than 3 times,
 * takes each over (public.portal_email_reclaim, so a user's retry at the same moment does not
 * send it twice), reads the status change again and sends it with the same Resend idempotency
 * key. A change that was replaced by a newer one of the same kind (its key no longer matches)
 * is recorded as skipped: the newer change has its own email. Bounded: a batch of rows and a
 * time budget. Does nothing while portal emails are turned off.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { portalEmailConfig, sendClaimedEmail, type PortalEvent } from "./portal-email";
import { reclaimRow, supabasePortalEmailStore } from "./portal-email-store";

export const MAX_ATTEMPTS = 3;
const BATCH = 20;
const STALE_SENDING_MS = 5 * 60_000;
const WINDOW_MS = 24 * 60 * 60_000;
const EVENTS: PortalEvent[] = ["sent", "declined", "finished", "failed", "accepted"];

export type RetrySummary = { tried: number; sent: number; failed: number; skipped: number };

type Row = { id: number; entity_id: string; external_id: string; status: string; at: string; attempted_at: string | null };

export async function retryPortalEmails(
  db: SupabaseClient,
  deps: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    now?: () => number;
    /** Stop starting new emails after this many milliseconds. */
    budgetMs?: number;
    limit?: number;
    /** Only these work orders (tests). */
    workOrderIds?: string[];
  } = {},
): Promise<RetrySummary> {
  const summary: RetrySummary = { tried: 0, sent: 0, failed: 0, skipped: 0 };
  const env = deps.env ?? process.env;
  if (!portalEmailConfig(env).enabled) return summary;
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.budgetMs ?? 45_000;

  let query = db
    .from("integration_sync")
    .select("id, entity_id, external_id, status, at, attempted_at")
    .eq("system", "email")
    .eq("entity", "portal_email")
    .in("status", ["error", "sending"])
    .gt("at", new Date(started - WINDOW_MS).toISOString())
    .lt("attempts", MAX_ATTEMPTS)
    .order("id", { ascending: true })
    .limit(deps.limit ?? BATCH);
  if (deps.workOrderIds) query = query.in("entity_id", deps.workOrderIds);
  const { data, error } = await query;
  if (error) throw new Error(`failed emails not read: ${error.message}`);

  const store = supabasePortalEmailStore(db);
  for (const row of (data ?? []) as Row[]) {
    if (now() - started > budget) break;
    // Still sending and claimed recently: its sender may be at work.
    if (row.status === "sending" && started - Date.parse(row.attempted_at ?? row.at) < STALE_SENDING_MS) continue;
    const event = row.external_id?.split(":")[0] as PortalEvent;
    if (!EVENTS.includes(event)) continue;
    if (!(await reclaimRow(db, row.id, MAX_ATTEMPTS))) continue;
    summary.tried += 1;

    let found;
    try {
      const componentId = event === "failed" ? await failedComponent(db, row.external_id.slice("failed:".length)) : undefined;
      found = event === "failed" ? (componentId ? await store.details(event, row.entity_id, componentId) : null) : await store.details(event, row.entity_id);
    } catch (e) {
      await store.finish(row.id, "error", `Retry: the status change could not be read (${e instanceof Error ? e.message : String(e)})`);
      summary.failed += 1;
      continue;
    }
    if (!found || found.key !== row.external_id) {
      await store.finish(row.id, "skipped", "Not sent: a newer change of this kind replaced it, or it is gone.");
      summary.skipped += 1;
      continue;
    }
    const { key, ...details } = found;
    const result = await sendClaimedEmail(event, row.entity_id, details, key, row.id, { store, env, fetchImpl: deps.fetchImpl });
    if (result.status === "ok") summary.sent += 1;
    else if (result.status === "skipped") summary.skipped += 1;
    else summary.failed += 1;
  }
  return summary;
}

/** The component of a failure row, or null when the failure or its component is gone. */
async function failedComponent(db: SupabaseClient, failureId: string): Promise<string | null> {
  const { data, error } = await db.from("component_failures").select("component_id").eq("id", failureId).maybeSingle();
  if (error) throw new Error(`component failure not read: ${error.message}`);
  return (data?.component_id as string | null | undefined) ?? null;
}
