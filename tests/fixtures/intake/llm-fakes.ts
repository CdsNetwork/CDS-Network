import type { LlmExtraction, LlmExtractor } from "@/lib/intake/llm";

/** A complete AI result with everything empty, to override per test. */
export function extraction(over: Partial<LlmExtraction> = {}): LlmExtraction {
  return {
    is_work_request: true,
    not_work_request_reason: null,
    customer_name: null,
    original_sender_email: null,
    location_number: null,
    location_name: null,
    location_address: null,
    unit_number: null,
    po_number: null,
    vin: null,
    fulfillment: "unknown",
    items: [],
    requested_work_summary: null,
    contact_name: null,
    notes: null,
    confidence: "medium",
    ...over,
  };
}

/** An AI stage that always answers with the given result. */
export const fakeLlm = (over: Partial<LlmExtraction> = {}): LlmExtractor => async () => ({
  ok: true,
  value: extraction(over),
  model: "claude-sonnet-5-5",
});

export const failingLlm: LlmExtractor = async () => ({ ok: false, error: "AI request failed (HTTP 529 overloaded_error)" });
