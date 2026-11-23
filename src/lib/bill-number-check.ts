import { billDocNumber } from "@/lib/qbo/bill";
import { madeForOrder, type FoundBill } from "@/lib/qbo/bill-run";

/**
 * Is this shop bill number already in QuickBooks? (Sarah, CDS, 2026-11-23: "QBO always gives a
 * warning if there is a bill number already processed under an account, so block the
 * affiliate from submitting a duplicate bill #".)
 *
 * Asked when the shop completes a job, before public.shop_complete_work_order runs (QuickBooks
 * stays out of the database transaction). Only a shop linked to a QuickBooks vendor is checked,
 * against that vendor's bills; the portal's own bill for this order does not count. When the
 * vendor link or QuickBooks cannot be read (not connected, an error, no answer in time) the
 * shop is not blocked and the reason is logged: the database still refuses a number another
 * order of the same shop already has (20261123010000_duplicate_bill_number.sql).
 */

export type BillNumberDeps = {
  /** The shop's QuickBooks vendor (qbo_affiliate_vendor), or null when it has none. */
  vendorFor(affiliateId: string): Promise<{ id: string; name: string } | null>;
  /** Bills with this bill number, any vendor (throws when QuickBooks cannot be asked). */
  findBills(docNumber: string): Promise<FoundBill[]>;
  log(note: string): void | Promise<void>;
  /** How long the shop waits for QuickBooks before completing without the check. */
  timeoutMs?: number;
};

const TIMEOUT_MS = 8_000;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function duplicateInQuickBooksMessage(ref: string): string {
  return `Bill number ${ref} is already in QuickBooks for your shop. Check the number and try again.`;
}

/** The refusal message, or null when the number may be used (or QuickBooks could not tell). */
export async function billNumberInQuickBooks(
  deps: BillNumberDeps,
  input: { ref: string; affiliateId: string; woNumber: number },
): Promise<string | null> {
  const ref = input.ref.trim();
  if (!ref) return null;

  let vendor: { id: string; name: string } | null;
  try {
    vendor = await deps.vendorFor(input.affiliateId);
  } catch (e) {
    await deps.log(`QuickBooks bill number check skipped: the shop's vendor link could not be read (${why(e)}).`);
    return null;
  }
  if (!vendor) return null;

  const doc = billDocNumber(ref);
  let bills: FoundBill[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("QuickBooks did not answer in time")), deps.timeoutMs ?? TIMEOUT_MS);
    });
    bills = await Promise.race([deps.findBills(doc), timeout]);
  } catch (e) {
    await deps.log(`QuickBooks bill number check skipped for ${doc} (vendor ${vendor.name}): ${why(e)}.`);
    return null;
  } finally {
    clearTimeout(timer);
  }

  const key = doc.toLowerCase();
  const duplicate = bills.some(
    (b) => b.VendorRef?.value === vendor.id && (b.DocNumber ?? "").trim().toLowerCase() === key && !madeForOrder(b, input.woNumber),
  );
  return duplicate ? duplicateInQuickBooksMessage(ref) : null;
}
