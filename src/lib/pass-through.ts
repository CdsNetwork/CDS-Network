/**
 * Lines priced per line (catalog_items.price_per_line), such as Misc. hardware: CDS enters
 * the amount from the shop's invoice and a description. The shop is paid that amount and
 * the customer is billed the same amount (no upcharge). Checked again by the database
 * function cds_add_pass_through_line.
 */

export const PASS_THROUGH_DESCRIPTION_MAX = 500;
export const PASS_THROUGH_AMOUNT_MAX = 99999.99;

export type PassThroughInput = { ok: true; description: string; amount: number } | { ok: false; error: string };

export function passThroughInput(description: string, amount: string): PassThroughInput {
  const text = description.trim();
  if (!text) return { ok: false, error: "Enter a description, for example the bolts and nuts on the shop's invoice." };
  if (text.length > PASS_THROUGH_DESCRIPTION_MAX) {
    return { ok: false, error: `Description is too long (max ${PASS_THROUGH_DESCRIPTION_MAX} characters).` };
  }
  const raw = amount.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { ok: false, error: "Enter the amount from the shop's invoice in dollars and cents." };
  const value = Number(raw);
  if (!(value > 0)) return { ok: false, error: "The amount must be more than zero." };
  if (value > PASS_THROUGH_AMOUNT_MAX) return { ok: false, error: "The amount is too large." };
  return { ok: true, description: text, amount: value };
}
