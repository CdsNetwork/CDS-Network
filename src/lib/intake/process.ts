/**
 * Ingest and process inbound emails. Storage sits behind IntakeStore so the flow can be
 * tested without a database; src/lib/intake/supabase-store.ts is the real one.
 *
 * Idempotency: the message id is unique in inbound_emails, so a second delivery of the same
 * email is recorded as a duplicate and not processed again; intake_create_draft_work_order
 * locks the email row and returns the existing order if one was already made.
 */
import { buildDraftParams, type DraftParams } from "./draft";
import type { LlmExtractor } from "./llm";
import { parseEmail } from "./parse";
import type { IntakeReference, NormalizedEmail, ParsedEmail } from "./types";

export type IntakeStatus = "new" | "parsed" | "failed" | "ignored" | "converted";
export type IntakeSource = "webhook" | "paste";

export type StoredEmail = {
  id: string;
  status: IntakeStatus;
  work_order_id: string | null;
  attempts: number;
  email: NormalizedEmail;
};

export type IntakeStore = {
  /** Inserts the email unless its message id is already stored. */
  insertEmail(email: NormalizedEmail, source: IntakeSource): Promise<{ id: string; inserted: boolean; status: IntakeStatus; work_order_id: string | null }>;
  getEmail(id: string): Promise<StoredEmail | null>;
  reference(): Promise<IntakeReference>;
  saveResult(
    id: string,
    result: { status: Exclude<IntakeStatus, "converted" | "new">; parsed: ParsedEmail | null; error: string | null; attempts: number },
  ): Promise<void>;
  /** Creates the draft order and marks the email converted (one transaction, in the database). */
  createDraft(params: DraftParams): Promise<string>;
};

export type IntakeOutcome = {
  id: string;
  duplicate: boolean;
  status: IntakeStatus;
  workOrderId: string | null;
  message: string | null;
};

export async function ingestEmail(
  store: IntakeStore,
  email: NormalizedEmail,
  options: { source: IntakeSource; llm: LlmExtractor | null },
): Promise<IntakeOutcome> {
  const record = await store.insertEmail(email, options.source);
  if (!record.inserted) {
    return {
      id: record.id,
      duplicate: true,
      status: record.status,
      workOrderId: record.work_order_id,
      message: "This email was already received; it was not processed again.",
    };
  }
  return processEmail(store, record.id, { llm: options.llm });
}

export async function processEmail(
  store: IntakeStore,
  id: string,
  options: { llm: LlmExtractor | null; forceWorkRequest?: boolean },
): Promise<IntakeOutcome> {
  const row = await store.getEmail(id);
  if (!row) throw new Error("Email not found");
  const outcome = (status: IntakeStatus, workOrderId: string | null, message: string | null): IntakeOutcome => ({
    id,
    duplicate: false,
    status,
    workOrderId,
    message,
  });
  if (row.work_order_id) return outcome("converted", row.work_order_id, "A draft work order already exists for this email.");

  const attempts = row.attempts + 1;
  let parsed: ParsedEmail | null = null;
  try {
    parsed = await parseEmail(row.email, await store.reference(), {
      llm: options.llm,
      forceWorkRequest: options.forceWorkRequest,
    });
    if (!parsed.is_work_request) {
      await store.saveResult(id, { status: "ignored", parsed, error: null, attempts });
      return outcome("ignored", null, parsed.ignore_reason);
    }
    const decision = buildDraftParams(id, row.email, parsed);
    // Store what was read first, so it is kept even if creating the order fails.
    await store.saveResult(id, { status: "parsed", parsed, error: decision.ok ? null : decision.reason, attempts });
    if (!decision.ok) return outcome("parsed", null, decision.reason);
    const workOrderId = await store.createDraft(decision.params);
    return outcome("converted", workOrderId, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.saveResult(id, { status: "failed", parsed, error: message.slice(0, 1000), attempts });
    return outcome("failed", null, message);
  }
}
