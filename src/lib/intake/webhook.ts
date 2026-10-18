import { validateNormalizedEmail } from "./email";
import type { LlmExtractor } from "./llm";
import { ingestEmail, type IntakeStore } from "./process";
import { presentedToken, tokenMatches } from "./token";

export const MAX_WEBHOOK_BODY = 5_000_000;

export type WebhookResult = { status: number; body: Record<string, unknown> };

/** The webhook's logic without Next.js, so it can be tested with a fake store. */
export async function handleIntakeWebhook(
  request: Request,
  deps: { token: string | null; store: () => IntakeStore; llm: LlmExtractor | null },
): Promise<WebhookResult> {
  if (!deps.token) return { status: 503, body: { error: "intake webhook is not configured" } };
  if (!tokenMatches(presentedToken(request.headers), deps.token)) return { status: 401, body: { error: "bad token" } };

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_WEBHOOK_BODY) return { status: 413, body: { error: "too large" } };
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BODY) return { status: 413, body: { error: "too large" } };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "not json" } };
  }
  const email = validateNormalizedEmail(json);
  if (!email.ok) return { status: 400, body: { error: email.error } };

  try {
    const outcome = await ingestEmail(deps.store(), email.value, { source: "webhook", llm: deps.llm });
    return {
      status: 200,
      body: {
        ok: true,
        id: outcome.id,
        duplicate: outcome.duplicate,
        status: outcome.status,
        work_order_id: outcome.workOrderId,
      },
    };
  } catch {
    // Not stored: answer 500 so the sender delivers the email again later.
    return { status: 500, body: { error: "not stored" } };
  }
}
