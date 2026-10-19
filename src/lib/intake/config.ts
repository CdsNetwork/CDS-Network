import { anthropicExtractor, DEFAULT_INTAKE_MODEL, type LlmExtractor } from "./llm";

/** The CDS inbox work requests arrive at. It must stay this address (CDS, 2026-10-18). */
export const INTAKE_MAILBOX = "dispatch@cds.direct";

/** CDS's own inboxes and groups that receive requests. Mail sent from one is CDS's own. */
export const CDS_INBOXES = ["dispatch@cds.direct", "xpo@cds.direct", "ryder@cds.direct"] as const;
/** CDS addresses whose mail is CDS writing to shops or suppliers, never a request. */
export const CDS_SENDERS = ["dispatch@cds.direct", "xpo@cds.direct"] as const;

/**
 * Inboxes that belong to one customer: a request arriving there is that customer's, matched
 * by the customer's code or name. Nothing is matched when no such customer exists.
 */
export const INBOX_CUSTOMERS: Record<string, string[]> = {
  "xpo@cds.direct": ["XPO"],
  "ryder@cds.direct": ["RYDER", "Ryder"],
};

/** The AI stage, or null when ANTHROPIC_API_KEY is not set (deterministic only, low confidence). */
export function intakeExtractor(env: Record<string, string | undefined> = process.env): LlmExtractor | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return anthropicExtractor({ apiKey, model: env.INTAKE_MODEL?.trim() || DEFAULT_INTAKE_MODEL });
}

export function intakeWebhookToken(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.INTAKE_WEBHOOK_TOKEN?.trim();
  // A short token is as good as none: refuse to run the webhook with it.
  return token && token.length >= 24 ? token : null;
}
