/**
 * Tracking by polling (CDS decision 2026-10-19: the tracking webhook is not registered, an
 * existing webhook on CDS's ShipStation account stays). Every 2 hours the cron route asks
 * ShipStation for each active real label whose leg is not delivered yet:
 *
 *   GET https://api.shipstation.com/v2/labels/{label_id}/track
 *   (https://docs.shipstation.com/tracking)
 *
 * Calls are sequential and spaced out (ShipStation allows about 200 requests a minute per
 * key); a 429 waits Retry-After and tries again, and a run that keeps hitting the limit
 * stops and leaves the rest for the next run (least recently checked labels go first).
 * Results go through the same status mapping as the webhook (parseTrackResponse) and the
 * same database function (private.apply_tracking). Each run is one integration_sync row.
 * No database or network access here: everything comes in through PollDeps.
 */
import { timingSafeEqual } from "node:crypto";
import { ShipStationError } from "./client";
import { parseTrackResponse, type ParsedTrack } from "./tracking";

export type LabelToTrack = { label_id: string; shipstation_label_id: string; tracking_number: string; carrier: string };

export type TrackResult = ParsedTrack | { error: string };

export type PollSummary = {
  checked: number;
  applied: number;
  unchanged: number;
  failed: number;
  /** Work orders the sweep moved to Delivered (orders completed after their leg was delivered). */
  delivered: number;
  /** Why the run stopped before checking every label, or null. */
  stopped: string | null;
  errors: string[];
};

export type PollDeps = {
  listLabels(limit: number): Promise<LabelToTrack[]>;
  /** The raw body of GET /v2/labels/{label_id}/track; throws ShipStationError. */
  track(shipstationLabelId: string): Promise<unknown>;
  /** Stores one result; answers 'applied', 'unchanged', 'error' or 'skipped'. */
  record(labelId: string, result: TrackResult): Promise<string>;
  sweep(): Promise<number>;
  recordRun(summary: PollSummary): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

export type PollOptions = {
  /** Labels per run (about 300 labels a month are made, so a run is rarely near this). */
  limit?: number;
  /** Pause between calls. */
  spacingMs?: number;
  /** Stop starting new calls after this long (the function has 300 s). */
  budgetMs?: number;
  /** Tries again after a 429 at most this many times per label. */
  maxRetries?: number;
};

const MAX_WAIT_MS = 60_000;

/** Vercel cron sends "Authorization: Bearer <CRON_SECRET>". Nothing passes while it is not set. */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  const s = secret?.trim();
  if (!s || !header) return false;
  const expected = Buffer.from(`Bearer ${s}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function pollTracking(deps: PollDeps, options: PollOptions = {}): Promise<PollSummary> {
  const { limit = 200, spacingMs = 400, budgetMs = 240_000, maxRetries = 2 } = options;
  const started = deps.now();
  const summary: PollSummary = { checked: 0, applied: 0, unchanged: 0, failed: 0, delivered: 0, stopped: null, errors: [] };

  const labels = await deps.listLabels(limit);
  labels: for (const [index, label] of labels.entries()) {
    if (index > 0) {
      if (deps.now() - started + spacingMs > budgetMs) {
        summary.stopped = `time budget reached, ${labels.length - index} label(s) left for the next run`;
        break;
      }
      if (spacingMs > 0) await deps.sleep(spacingMs);
    }

    let result: TrackResult | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        result = parseTrackResponse(await deps.track(label.shipstation_label_id));
        break;
      } catch (e) {
        const error = e instanceof ShipStationError ? e : new ShipStationError(e instanceof Error ? e.message : "unknown error", 0);
        if (error.rateLimited) {
          if (attempt >= maxRetries) {
            summary.stopped = `ShipStation rate limit reached, ${labels.length - index} label(s) left for the next run`;
            break labels;
          }
          await deps.sleep(Math.min((error.retryAfterSeconds ?? 30) * 1000, MAX_WAIT_MS));
          continue;
        }
        if (error.status === 401 || error.status === 403) {
          summary.stopped = error.message;
          break labels;
        }
        result = { error: error.message.slice(0, 1000) };
        break;
      }
    }

    summary.checked++;
    const outcome = await deps.record(label.label_id, result);
    if ("error" in result) {
      summary.failed++;
      if (summary.errors.length < 5) summary.errors.push(`${label.carrier} ${label.tracking_number}: ${result.error}`);
    } else if (outcome === "applied") summary.applied++;
    else summary.unchanged++;
  }

  summary.delivered = await deps.sweep();
  await deps.recordRun(summary);
  return summary;
}

/** The integration_sync row of one run: status ok, partial (some labels failed) or error. */
export function runRow(summary: PollSummary) {
  const counts = `checked ${summary.checked}, updated ${summary.applied}, unchanged ${summary.unchanged}, failed ${summary.failed}, moved to delivered ${summary.delivered}`;
  const note = [counts, summary.stopped && `stopped: ${summary.stopped}`, ...summary.errors].filter(Boolean).join("; ");
  return {
    system: "shipstation",
    entity: "tracking_poll",
    direction: "pull",
    status: summary.stopped && summary.checked === 0 ? "error" : summary.failed || summary.stopped ? "partial" : "ok",
    error: note.slice(0, 2000),
  };
}
