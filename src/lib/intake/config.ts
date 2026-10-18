import { anthropicExtractor, DEFAULT_INTAKE_MODEL, type LlmExtractor } from "./llm";

/** The CDS inbox work requests arrive at. It must stay this address (CDS, 2026-10-18). */
export const INTAKE_MAILBOX = "dispatch@cds.direct";

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
