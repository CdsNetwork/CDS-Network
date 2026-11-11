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

type Amount = { ok: true; amount: number } | { ok: false; error: string };

/** Dollars and cents typed by CDS ("$1,250.5" is 1250.5). Null when it is not a number. */
function dollars(amount: string): number | null {
  const raw = amount.trim().replace(/^\$/, "").replace(/,/g, "");
  return /^\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : null;
}

/**
 * The shop rate CDS enters on a line whose rate is TBD (First Student's AM gaskets and
 * clamps, items priced on the order). Zero is allowed. Checked again by the database function
 * cds_set_line_shop_rate.
 */
export function shopRateInput(amount: string, label = "shop rate"): Amount {
  const value = dollars(amount);
  if (value === null) return { ok: false, error: `Enter the ${label} in dollars and cents.` };
  if (value > PASS_THROUGH_AMOUNT_MAX) return { ok: false, error: `The ${label} is too large.` };
  return { ok: true, amount: value };
}

export type PricedLineInput =
  | { ok: true; description: string; amount: number; shopRate: number | null }
  | { ok: false; error: string };

/**
 * An item priced on the order (reconditioned and new filters): the customer price CDS
 * quoted, an optional description, and the shop rate when it is known (else TBD).
 */
export function pricedLineInput(description: string, amount: string, shopRate: string, rateLabel = "shop rate"): PricedLineInput {
  const text = description.trim();
  if (text.length > PASS_THROUGH_DESCRIPTION_MAX) {
    return { ok: false, error: `Description is too long (max ${PASS_THROUGH_DESCRIPTION_MAX} characters).` };
  }
  const price = dollars(amount);
  if (price === null) return { ok: false, error: "Enter the customer price in dollars and cents." };
  if (!(price > 0)) return { ok: false, error: "The customer price must be more than zero." };
  if (price > PASS_THROUGH_AMOUNT_MAX) return { ok: false, error: "The customer price is too large." };
  if (!shopRate.trim()) return { ok: true, description: text, amount: price, shopRate: null };
  const rate = shopRateInput(shopRate, rateLabel);
  if (!rate.ok) return rate;
  return { ok: true, description: text, amount: price, shopRate: rate.amount };
}
