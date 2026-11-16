import type { ParsedEmail } from "./types";

/**
 * A parsed email as the Email Intake page shows it. Rows saved by older code, or edited by
 * hand, can miss parts (no fields, no llm block), so every part has a safe empty value.
 */
export type ParsedView = Pick<
  ParsedEmail,
  "template" | "mailbox" | "po_reference" | "ignore_reason" | "customer" | "customer_candidates" | "location" | "location_candidates" | "items" | "warnings"
> & {
  fields: Partial<ParsedEmail["fields"]>;
  llm: ParsedEmail["llm"];
  confidence: number | null;
  confidence_label: ParsedEmail["confidence_label"] | null;
};

type Raw = Partial<Omit<ParsedEmail, "fields" | "llm">> & {
  fields?: Partial<ParsedEmail["fields"]> | null;
  llm?: Partial<ParsedEmail["llm"]> | null;
};

const list = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

export function parsedView(parsed: ParsedEmail | null | undefined): ParsedView | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Raw;
  return {
    template: p.template ?? null,
    mailbox: p.mailbox ?? null,
    po_reference: p.po_reference ?? null,
    ignore_reason: p.ignore_reason ?? null,
    fields: p.fields && typeof p.fields === "object" ? p.fields : {},
    llm: { used: p.llm?.used === true, model: p.llm?.model ?? null, error: p.llm?.error ?? null },
    customer: p.customer ?? null,
    customer_candidates: list(p.customer_candidates),
    location: p.location ?? null,
    location_candidates: list(p.location_candidates),
    items: list(p.items),
    warnings: list(p.warnings),
    confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence) ? p.confidence : null,
    confidence_label: p.confidence_label ?? null,
  };
}
