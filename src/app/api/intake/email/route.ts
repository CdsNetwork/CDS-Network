import { NextResponse } from "next/server";
import { intakeExtractor, intakeWebhookToken } from "@/lib/intake/config";
import { handleIntakeWebhook } from "@/lib/intake/webhook";
import { supabaseIntakeStore } from "@/lib/intake/supabase-store";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Inbound work request emails, already converted to the normalized JSON shape
 * (src/lib/intake/types.ts NormalizedEmail) by whatever reads dispatch@cds.direct: a
 * forwarding service, Gmail push, or Resend inbound.
 *
 * POST https://<portal domain>/api/intake/email
 *   Authorization: Bearer <INTAKE_WEBHOOK_TOKEN>   (or x-intake-token: <token>)
 *   { "messageId", "from", "to", "subject", "receivedAt", "text", "html", "attachments" }
 *
 * The same messageId is processed once; a repeat answers 200 with duplicate: true.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Reading one email with the AI stage takes a few seconds; allow for a slow response.
export const maxDuration = 120;

export async function POST(request: Request) {
  const result = await handleIntakeWebhook(request, {
    token: intakeWebhookToken(),
    store: () => supabaseIntakeStore(createAdminClient()),
    llm: intakeExtractor(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
