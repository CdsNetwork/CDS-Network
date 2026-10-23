import { NextResponse } from "next/server";
import { sheetsConfig } from "@/lib/sheets/config";
import { runSheetsBackup } from "@/lib/sheets/run";
import { cronAuthorized } from "@/lib/shipstation/poll";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Google Sheets backup, run by Vercel cron every 15 minutes (vercel.json). Vercel sends
 * "Authorization: Bearer <CRON_SECRET>"; anything else answers 401. Not configured: 503 and
 * nothing else happens. See src/lib/sheets/sync.ts for what a run does; a failed run is
 * recorded in integration_sync (system 'sheets').
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!sheetsConfig()) return NextResponse.json({ error: "Google Sheets backup is not configured" }, { status: 503 });
  const run = await runSheetsBackup(createAdminClient());
  if (!run) return NextResponse.json({ error: "Google Sheets backup is not configured" }, { status: 503 });
  return NextResponse.json(run, { status: run.status === "ok" ? 200 : 500 });
}
