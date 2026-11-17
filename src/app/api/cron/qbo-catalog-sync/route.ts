import { NextResponse } from "next/server";
import { syncCatalogFromQuickBooks } from "@/lib/qbo/catalog-sync-server";
import { cronAuthorized } from "@/lib/shipstation/poll";

/**
 * Adds QuickBooks items that are missing in the portal catalog (src/lib/qbo/catalog-sync.ts),
 * run by Vercel cron every hour (vercel.json). Vercel sends "Authorization: Bearer
 * <CRON_SECRET>"; anything else answers 401. While QuickBooks is not connected it does nothing
 * and answers 200 (skipped). A failed run is recorded and answers 500. With ?dry=1 it answers
 * the plan (what a run would create, link and skip) and writes nothing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dry") === "1";
  const result = await syncCatalogFromQuickBooks("cron", { dryRun });
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
}
