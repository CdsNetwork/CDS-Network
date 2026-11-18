import { money } from "@/lib/format";
import type { QboInvoicePayload } from "./invoice";

/**
 * The shipping charge in the QuickBooks invoice's own Shipping box (CDS, 2026-11-18). Pure.
 *
 * QuickBooks Online shows a sales line whose ItemRef is the reserved value "SHIPPING_ITEM_ID"
 * in the Shipping field at the bottom of the invoice (next to the tax), not as a product
 * line. It needs the company preference Preferences.SalesFormsPrefs.AllowShipping (in
 * QuickBooks: Settings > Account and settings > Sales > Sales form content > Shipping). The
 * line carries only the amount and whether it is taxable:
 *   { DetailType: "SalesItemLineDetail", Amount,
 *     SalesItemLineDetail: { ItemRef: { value: "SHIPPING_ITEM_ID" }, TaxCodeRef: { value: "TAX" | "NON" } } }
 *
 * The amount comes from public.work_order_customer_shipping (the database decides it).
 *
 * GESi filters sold (Sarah, CDS, 2026-11-18) are charged on a normal item line instead, the
 * QuickBooks item "Shipping and Handling (G)": $28 per GESi filter, $150 when overnighted
 * (the view's gesi_amount). The portal catalog has no such item (the QuickBooks catalog sync
 * skips names with spaces, and qbo_item_map links portal items only), so the line is built
 * with an empty ItemRef value and the item name, and resolveInvoiceQbo (./invoice-qbo) puts
 * in the id of the active QuickBooks item with exactly that name, or stops the invoice with
 * GesiShippingItemError before anything is sent:
 *   { DetailType: "SalesItemLineDetail", Amount, Description,
 *     SalesItemLineDetail: { ItemRef: { value: "<id>", name: "Shipping and Handling (G)" },
 *                            Qty, UnitPrice, TaxCodeRef: { value: "TAX" | "NON" } } }
 */

export const SHIPPING_ITEM_ID = "SHIPPING_ITEM_ID";

/** Only the amount and the tax code: no description, quantity or unit price. */
export type QboShippingLine = {
  DetailType: "SalesItemLineDetail";
  Amount: number;
  Description?: never;
  SalesItemLineDetail: { ItemRef: { value: typeof SHIPPING_ITEM_ID; name?: never }; Qty?: never; UnitPrice?: never; TaxCodeRef: { value: "TAX" | "NON" } };
};

export function shippingLine(amount: number, taxable: boolean): QboShippingLine {
  return {
    DetailType: "SalesItemLineDetail",
    Amount: amount,
    SalesItemLineDetail: { ItemRef: { value: SHIPPING_ITEM_ID }, TaxCodeRef: { value: taxable ? "TAX" : "NON" } },
  };
}

export function isShippingLine(line: { SalesItemLineDetail: { ItemRef: { value: string } } }): line is QboShippingLine {
  return line?.SalesItemLineDetail?.ItemRef?.value === SHIPPING_ITEM_ID;
}

/** The amount in the invoice's Shipping box, 0 when there is none. */
export function shippingAmountOf(payload: Pick<QboInvoicePayload, "Line">): number {
  return payload.Line.filter(isShippingLine).reduce((sum, l) => sum + l.Amount, 0);
}

export const GESI_SHIPPING_ITEM_NAME = "Shipping and Handling (G)";

/** The GESi shipping of one work order (public.work_order_customer_shipping). */
export type GesiShipping = {
  /** GESi filters sold. */
  qty: number;
  /** Per GESi filter: $28, or $150 when overnighted. */
  unitAmount: number;
  /** gesi_amount: qty x unitAmount, or CDS's override. */
  amount: number;
  overnight: boolean;
};

export type QboGesiShippingLine = {
  DetailType: "SalesItemLineDetail";
  Amount: number;
  Description: string;
  SalesItemLineDetail: {
    ItemRef: { value: string; name: typeof GESI_SHIPPING_ITEM_NAME };
    Qty: number;
    UnitPrice: number;
    TaxCodeRef: { value: "TAX" | "NON" };
  };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The line before its QuickBooks id is known (ItemRef value ""). Qty x unit price when the
 * amount is the automatic one; one unit of the amount when CDS set it by hand.
 */
export function gesiShippingLine(g: GesiShipping, taxable: boolean): QboGesiShippingLine {
  const amount = round2(g.amount);
  const automatic = g.qty > 0 && round2(g.qty * g.unitAmount) === amount;
  const description = automatic
    ? `${GESI_SHIPPING_ITEM_NAME}: ${g.qty} GESi ${g.qty === 1 ? "filter" : "filters"} x ${money(g.unitAmount)}${g.overnight ? " (overnight)" : ""}`
    : GESI_SHIPPING_ITEM_NAME;
  return {
    DetailType: "SalesItemLineDetail",
    Amount: amount,
    Description: description,
    SalesItemLineDetail: {
      ItemRef: { value: "", name: GESI_SHIPPING_ITEM_NAME },
      Qty: automatic ? g.qty : 1,
      UnitPrice: automatic ? g.unitAmount : amount,
      TaxCodeRef: { value: taxable ? "TAX" : "NON" },
    },
  };
}

export function isGesiShippingLine(line: { SalesItemLineDetail: { ItemRef: { value: string; name?: string } } }): boolean {
  return line?.SalesItemLineDetail?.ItemRef?.name === GESI_SHIPPING_ITEM_NAME;
}

/** The GESi shipping item could not be found in QuickBooks: found before sending. */
export class GesiShippingItemError extends Error {
  constructor(reason: string) {
    super(
      `The invoice has a GESi shipping charge on the QuickBooks item "${GESI_SHIPPING_ITEM_NAME}", but ${reason}. Check that the item exists and is active in QuickBooks with exactly that name, or set the shipping charge on the work order to $0, then click Create QuickBooks invoice again.`,
    );
    this.name = "GesiShippingItemError";
  }
}

const FIX =
  "Turn on Shipping in QuickBooks (Settings > Account and settings > Sales > Sales form content > Shipping), or set the shipping charge on the work order to $0, then click Create QuickBooks invoice again.";

/** QuickBooks says the company does not allow shipping on invoices: found before sending. */
export class ShippingNotAllowedError extends Error {
  constructor(amount: number) {
    super(`The invoice has a shipping charge of ${money(amount)}, but Shipping is turned off on sales forms in this QuickBooks company. ${FIX}`);
    this.name = "ShippingNotAllowedError";
  }
}

/**
 * A clear message when QuickBooks refused an invoice with a shipping charge because of the
 * shipping line; null for any other refusal (shown as before).
 */
export function shippingRefusalMessage(message: string, payload: Pick<QboInvoicePayload, "Line">): string | null {
  const amount = shippingAmountOf(payload);
  if (!(amount > 0) || !/ship/i.test(message)) return null;
  return `QuickBooks refused the shipping charge of ${money(amount)}: this QuickBooks company may not allow shipping on invoices. ${FIX} QuickBooks said: ${message}`;
}
