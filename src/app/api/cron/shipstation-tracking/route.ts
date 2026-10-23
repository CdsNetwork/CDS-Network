import { NextResponse } from "next/server";
import { recordSync } from "@/lib/integration-sync";
import { shipStationRequest } from "@/lib/shipstation/client";
import { shipStationConfig } from "@/lib/shipstation/config";
import { cronAuthorized, pollTracking, runRow, type LabelToTrack } from "@/lib/shipstation/poll";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Tracking poll, run by Vercel cron every 2 hours (vercel.json). Vercel sends
 * "Authorization: Bearer <CRON_SECRET>"; anything else answers 401. See
 * src/lib/shipstation/poll.ts for what a run does.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const config = shipStationConfig();
  if (!config) return NextResponse.json({ error: "ShipStation is not configured" }, { status: 503 });

  const db = createAdminClient();
  try {
    const summary = await pollTracking({
      listLabels: async (limit) => {
        const { data, error } = await db.rpc("shipstation_labels_to_track", { p_limit: limit });
        if (error) throw new Error(`could not list labels: ${error.message}`);
        return (data ?? []) as LabelToTrack[];
      },
      track: (labelId) => shipStationRequest(config.apiKey, "GET", `labels/${encodeURIComponent(labelId)}/track`, { timeoutMs: 20_000 }),
      record: async (labelId, result) => {
        const failed = "error" in result;
        const { data, error } = await db.rpc("shipstation_record_tracking", {
          p_label: labelId,
          p_status_code: failed ? null : result.statusCode,
          p_status: failed ? null : result.status,
          p_estimated_delivery: failed ? null : result.estimatedDelivery,
          p_actual_delivery: failed ? null : result.actualDelivery,
          p_events: failed
            ? []
            : result.events.map((e) => ({ occurred_at: e.occurredAt, carrier_code: e.carrierCode, description: e.description, location: e.location })),
          p_error: failed ? result.error : null,
        });
        if (error) throw new Error(`could not store tracking: ${error.message}`);
        return String(data);
      },
      sweep: async () => {
        const { data, error } = await db.rpc("shipstation_auto_deliver_sweep");
        if (error) throw new Error(`could not run the Delivered sweep: ${error.message}`);
        return Number(data ?? 0);
      },
      recordRun: async (summary) => {
        const { error } = await db.from("integration_sync").insert(runRow(summary));
        if (error) throw new Error(`could not record the run: ${error.message}`);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = (e instanceof Error ? e.message : "unknown error").slice(0, 2000);
    await recordSync(db, { system: "shipstation", entity: "tracking_poll", direction: "pull", status: "error", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
