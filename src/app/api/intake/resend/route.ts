import { NextResponse } from "next/server";
import { intakeExtractor } from "@/lib/intake/config";
import { handleResendWebhook, resendIntakeConfig } from "@/lib/intake/resend";
import { supabaseIntakeStore } from "@/lib/intake/supabase-store";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Resend inbound webhook for the email intake (dispatch@cds.direct forwarded to
 * intake@in.cds.direct). Setup and flow: src/lib/intake/resend.ts.
 *
 * Configure:
 *   Resend webhook  https://<portal domain>/api/intake/resend, event email.received
 *   RESEND_WEBHOOK_SECRET      the webhook's signing secret (whsec_...)
 *   RESEND_RECEIVING_API_KEY   a Resend API key that can read received emails
 * Without both env values the route answers 503 "not configured".
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fetching the email from Resend and reading it with the AI stage takes a few seconds.
export const maxDuration = 120;

export async function POST(request: Request) {
  const result = await handleResendWebhook(request, {
    config: resendIntakeConfig(),
    store: () => supabaseIntakeStore(createAdminClient()),
    llm: intakeExtractor(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
