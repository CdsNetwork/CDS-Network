import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { shipStationConfig, SHIPSTATION_JWKS_URL } from "@/lib/shipstation/config";
import { parseTrackWebhook } from "@/lib/shipstation/tracking";
import { createJwksKeyFinder, tokenMatches, verifyWebhook } from "@/lib/shipstation/webhook-verify";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * ShipStation tracking webhook (event "track"). NOT registered: CDS keeps an existing
 * webhook on the account (2026-10-19), so tracking is polled instead
 * (src/app/api/cron/shipstation-tracking/route.ts). Both apply results through the same
 * database function (private.apply_tracking). It could be registered later as
 * https://<portal domain>/api/shipstation/webhook.
 *
 * Authenticity: the RSA-SHA256 signature ShipStation puts on every webhook (see
 * src/lib/shipstation/webhook-verify.ts). When SHIPSTATION_WEBHOOK_TOKEN is set, the
 * x-cds-webhook-token header must carry it as well (set as a custom header on the webhook).
 * Each delivery is applied once (by the hash of its body); answering quickly keeps
 * ShipStation from retrying.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1_000_000;
const findKey = createJwksKeyFinder(SHIPSTATION_JWKS_URL);

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "too large" }, { status: 413 });

  const verified = await verifyWebhook({ headers: request.headers, rawBody: raw, findKey });
  if (!verified.ok) return NextResponse.json({ error: verified.reason }, { status: verified.status });

  const config = shipStationConfig();
  if (config?.webhookToken && !tokenMatches(request.headers.get("x-cds-webhook-token"), config.webhookToken)) {
    return NextResponse.json({ error: "bad token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "not json" }, { status: 400 });
  }
  const parsed = parseTrackWebhook(body);
  if (parsed.kind === "invalid") return NextResponse.json({ error: parsed.reason }, { status: 400 });

  const track = parsed.kind === "track" ? parsed : null;
  const { data, error } = await createAdminClient().rpc("shipstation_record_webhook", {
    p_body_sha256: createHash("sha256").update(raw).digest("hex"),
    p_resource_type: track ? "API_TRACK" : parsed.kind === "ignored" ? parsed.resourceType : "unknown",
    p_tracking_number: track?.trackingNumber ?? null,
    p_status_code: track?.statusCode ?? null,
    p_status: track?.status ?? null,
    p_estimated_delivery: track?.estimatedDelivery ?? null,
    p_actual_delivery: track?.actualDelivery ?? null,
    p_events: (track?.events ?? []).map((e) => ({
      occurred_at: e.occurredAt,
      carrier_code: e.carrierCode,
      description: e.description,
      location: e.location,
    })),
    p_payload: body,
  });
  // A database error answers 500 so ShipStation sends the webhook again later.
  if (error) return NextResponse.json({ error: "not stored" }, { status: 500 });
  return NextResponse.json({ ok: true, outcome: data });
}
