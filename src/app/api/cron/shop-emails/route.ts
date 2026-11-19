import { NextResponse } from "next/server";
import { runShopEmails } from "@/lib/shop-email-run";
import { supabaseShopEmailStore } from "@/lib/shop-email-store";
import { cronAuthorized } from "@/lib/shipstation/poll";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Emails to shops (src/lib/shop-email-run.ts), run by Vercel cron every 5 minutes (vercel.json):
 * makes the due reminders, sends queued notices (the debounced line change emails among them)
 * and retries failed ones. Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else
 * answers 401. While PORTAL_EMAILS_ENABLED is not "true" it sends nothing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runShopEmails(supabaseShopEmailStore(createAdminClient()), { budgetMs: 40_000 });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = (e instanceof Error ? e.message : "unknown error").slice(0, 2000);
    console.error(`Shop emails: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
