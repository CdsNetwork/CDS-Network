import { NextResponse } from "next/server";
import { retryPortalEmails } from "@/lib/portal-email-retry";
import { cronAuthorized } from "@/lib/shipstation/poll";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Retries status emails to CDS that failed (src/lib/portal-email-retry.ts), run by Vercel cron
 * every 15 minutes (vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything
 * else answers 401. While portal emails are turned off it does nothing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await retryPortalEmails(createAdminClient(), { budgetMs: 40_000 });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = (e instanceof Error ? e.message : "unknown error").slice(0, 2000);
    console.error(`Portal email retry: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
