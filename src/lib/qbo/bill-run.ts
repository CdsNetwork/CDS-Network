import { money } from "@/lib/format";
import {
  billItemIds,
  billState,
  defaultBillTerm,
  hasBillFieldValues,
  itemsWithoutExpenseAccount,
  withBillCustomFields,
  shouldAutoCreate,
  type BillInputs,
  type BillRecord,
  type QboBillItem,
  type QboBillPayload,
  type QboBillTerm,
} from "./bill";
import { matchCogsDivision, type CogsDivision, type QboDepartment } from "./cogs-division";
import { billCustomFieldDefs } from "./custom-fields";
import { QboError } from "./client";

/**
 * Creates the shop's bill for one work order (M3). The database and QuickBooks come in as
 * deps, so this runs the same for the automatic run after the shop completes (service role,
 * Next after()) and for CDS's Create bill / Retry button, and is tested with stubs.
 *
 * Never two bills for one order:
 *   1. public.qbo_claim_shop_bill takes the order's one claim in the database (refused while
 *      another run holds it, and once a bill is recorded) and returns the request id.
 *   2. Before sending, QuickBooks is asked for bills with this bill number from this vendor:
 *      one the portal made for this order (its memo names the order) is recorded instead of
 *      sending another; one made otherwise (CDS typed it by hand) stops the run with a note.
 *   3. The bill's QuickBooks items are read in one query: an item without an expense account
 *      (QuickBooks would refuse it) stops the run with the item named, recorded as a refusal
 *      CDS retries after fixing the item in QuickBooks. Read alongside, and never stopping
 *      the bill: the customer's COGS division when none is remembered yet (found by name,
 *      ./cogs-division, then remembered), the Net 30 term when CDS chose no terms, and the
 *      bill custom fields Fleet Number and P.O. Number (learned from recent bills; a value
 *      whose field is not found stays in the memo, ./bill withBillCustomFields).
 *   4. The bill is sent with Intuit's requestid ("bill-<order id>"), so a retry after a
 *      timeout or a lost answer gets the same bill back. Only after QuickBooks refused the
 *      request outright (nothing created) does the next attempt use "bill-<id>-r<n>".
 *   5. public.qbo_finish_shop_bill records the bill, or the failure for CDS to see and retry.
 */

export type BillClaim = { claimId: string; requestId: string };

export type BillOutcome =
  | { outcome: "created"; billId: string; number: string | null; total: number | null; vendorId: string; found: boolean }
  | { outcome: "rejected"; error: string }
  | { outcome: "error"; error: string };

export type CreatedBill = { Id: string; DocNumber?: string; TotalAmt?: number };
export type FoundBill = { Id: string; DocNumber?: string; VendorRef?: { value?: string }; TotalAmt?: number; PrivateNote?: string };

export type BillQbo = {
  findBills(docNumber: string): Promise<FoundBill[]>;
  /** The items with these ids (one query), for their expense account. */
  getItems(ids: string[]): Promise<QboBillItem[]>;
  listDepartments(): Promise<QboDepartment[]>;
  listTerms(): Promise<QboBillTerm[]>;
  /** Recent bills read with include=enhancedAllCustomFields, to learn the bill custom fields. */
  recentBillCustomFields(): Promise<{ CustomField?: { DefinitionId?: string; Name?: string }[] }[]>;
  createBill(payload: QboBillPayload, requestId: string): Promise<CreatedBill>;
};

export type BillRunDeps = {
  load(woId: string): Promise<{ inputs: BillInputs; record: BillRecord | null } | null>;
  /** Throws with a readable message when the claim is refused. */
  claim(woId: string): Promise<BillClaim>;
  finish(woId: string, claimId: string, outcome: BillOutcome): Promise<void>;
  qbo(options?: { forceRefresh?: boolean }): Promise<BillQbo>;
  /** Remembers the customer's COGS division, insert only (a row CDS added wins); never throws. */
  saveDivision(customerId: string, division: CogsDivision): Promise<void>;
  /** integration_sync audit row; never throws. */
  log(status: "ok" | "rejected" | "error", externalId: string | null, note: string | null): Promise<void>;
};

export type BillRunResult = { status: "created"; message: string } | { status: "skipped"; reason: string } | { status: "failed"; message: string };

const why = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

/** True when a bill's memo says the portal made it for this order. */
export function madeForOrder(bill: FoundBill, woNumber: number): boolean {
  return new RegExp(`(^|\\W)Portal WO-${woNumber}(\\W|$)`).test(bill.PrivateNote ?? "");
}

export async function runShopBill(deps: BillRunDeps, woId: string, mode: "auto" | "manual"): Promise<BillRunResult> {
  const loaded = await deps.load(woId);
  if (!loaded) return mode === "auto" ? { status: "skipped", reason: "not_found" } : { status: "failed", message: "Work order not found." };
  const { inputs, record } = loaded;
  const state = billState(inputs, record);

  if (mode === "auto") {
    if (!shouldAutoCreate(state, record)) return { status: "skipped", reason: state.kind };
  } else if (state.kind !== "ready") {
    switch (state.kind) {
      case "created":
        return { status: "failed", message: `This work order already has QuickBooks bill ${state.number ?? `id ${state.billId}`}.` };
      case "not_set_up":
        return { status: "failed", message: "QuickBooks bills are not set up yet." };
      case "creating":
        return { status: "failed", message: "A QuickBooks bill is already being created for this work order. Refresh in a moment." };
      case "blocked":
        return { status: "failed", message: `Fix these first: ${state.problems.join(" ")}` };
      default:
        return { status: "failed", message: "This work order does not get a shop bill." };
    }
  }
  if (state.kind !== "ready") return { status: "skipped", reason: state.kind };
  const { payload, total } = state;

  let claim: BillClaim;
  try {
    claim = await deps.claim(woId);
  } catch (e) {
    // Another run holds the order or recorded the bill meanwhile.
    return mode === "auto" ? { status: "skipped", reason: why(e) } : { status: "failed", message: why(e) };
  }

  const vendorId = payload.VendorRef.value;
  const vendorName = payload.VendorRef.name ?? `vendor ${vendorId}`;
  const findDivision = async (qbo: BillQbo): Promise<CogsDivision | null> => {
    try {
      const match = matchCogsDivision(
        { incomeDivision: inputs.incomeDivisionName, customerName: inputs.workOrder.customerName },
        await qbo.listDepartments(),
      );
      if (match) await deps.saveDivision(inputs.workOrder.customerId, match);
      return match;
    } catch {
      return null;
    }
  };
  /** The bill's custom fields; never stops the bill (only an expired token is passed on, to refresh and retry). */
  const fieldNotes: string[] = [];
  const findFields = async (qbo: BillQbo) => {
    if (!hasBillFieldValues(inputs.workOrder)) return null;
    try {
      return billCustomFieldDefs(await qbo.recentBillCustomFields());
    } catch (e) {
      if (e instanceof QboError && e.unauthorized) throw e;
      fieldNotes.push(`The QuickBooks bill custom fields could not be read (${why(e)}), so the PO and unit are in the bill memo.`);
      return null;
    }
  };
  const send = async (qbo: BillQbo): Promise<{ bill: CreatedBill; found: boolean } | { conflict: FoundBill } | { noExpenseAccount: string[] }> => {
    const same = (await qbo.findBills(payload.DocNumber)).filter((b) => b.VendorRef?.value === vendorId);
    const ours = same.find((b) => madeForOrder(b, inputs.workOrder.woNumber));
    if (ours) return { bill: ours, found: true };
    if (same.length) return { conflict: same[0] };
    const ids = billItemIds(payload);
    fieldNotes.length = 0;
    const [items, division, term, fieldDefs] = await Promise.all([
      ids.length ? qbo.getItems(ids) : Promise.resolve([]),
      payload.DepartmentRef ? Promise.resolve(null) : findDivision(qbo),
      payload.SalesTermRef ? Promise.resolve(null) : qbo.listTerms().then(defaultBillTerm, () => null),
      findFields(qbo),
    ]);
    const missing = itemsWithoutExpenseAccount(payload, items);
    if (missing.length) return { noExpenseAccount: missing };
    let withFields = payload;
    if (fieldDefs) {
      const filled = withBillCustomFields(payload, inputs.workOrder, fieldDefs);
      withFields = filled.payload;
      fieldNotes.push(...filled.notes);
    }
    const toSend: QboBillPayload = {
      ...withFields,
      ...(division ? { DepartmentRef: { value: division.id, name: division.name } } : {}),
      ...(term ? { SalesTermRef: term } : {}),
    };
    return { bill: await qbo.createBill(toSend, claim.requestId), found: false };
  };

  let result: Awaited<ReturnType<typeof send>>;
  try {
    try {
      result = await send(await deps.qbo());
    } catch (e) {
      if (!(e instanceof QboError && e.unauthorized)) throw e;
      // The access token was revoked or expired early: refresh once and send the same request.
      result = await send(await deps.qbo({ forceRefresh: true }));
    }
  } catch (e) {
    const qbo = e instanceof QboError ? e : null;
    const rejected = !!qbo?.rejected;
    const message =
      qbo?.faultType === "Config"
        ? qbo.message
        : rejected
          ? `QuickBooks refused the bill: ${why(e)}`
          : `QuickBooks did not confirm the bill (${why(e)}). Try again: a retry never creates a second bill.`;
    await deps.log(rejected ? "rejected" : "error", null, `${message}${qbo?.intuitTid ? ` (intuit_tid ${qbo.intuitTid})` : ""}`);
    await deps.finish(woId, claim.claimId, { outcome: rejected ? "rejected" : "error", error: message });
    return { status: "failed", message };
  }

  if ("noExpenseAccount" in result) {
    // Nothing was sent: recorded as a refusal, so CDS's retry uses a new request id.
    const message = result.noExpenseAccount.join(" ");
    await deps.log("rejected", null, message);
    await deps.finish(woId, claim.claimId, { outcome: "rejected", error: message });
    return { status: "failed", message };
  }

  if ("conflict" in result) {
    const c = result.conflict;
    const amount = c.TotalAmt === undefined ? "" : ` (${money(c.TotalAmt)})`;
    const message = `QuickBooks already has bill ${c.DocNumber ?? payload.DocNumber} from ${vendorName}${amount}, not made for this order. Check it in QuickBooks; no bill was created.`;
    await deps.log("error", c.Id, message);
    await deps.finish(woId, claim.claimId, { outcome: "error", error: message });
    return { status: "failed", message };
  }

  const { bill, found } = result;
  const number = bill.DocNumber ?? payload.DocNumber;
  const billTotal = typeof bill.TotalAmt === "number" ? bill.TotalAmt : total;
  await deps.log(
    "ok",
    bill.Id,
    [`QuickBooks bill number ${number}`, found ? "found in QuickBooks, not sent again" : null, ...(found ? [] : fieldNotes)].filter(Boolean).join(" | "),
  );
  try {
    await deps.finish(woId, claim.claimId, { outcome: "created", billId: bill.Id, number, total: billTotal, vendorId, found });
  } catch (e) {
    // The claim stays until it expires; the next run finds this bill by its memo (step 2).
    const message = `QuickBooks bill ${number} was created, but the work order could not be updated (${why(e)}). Retry in a few minutes; no second bill is created.`;
    await deps.log("error", bill.Id, message);
    return { status: "failed", message };
  }
  return {
    status: "created",
    message: found
      ? `QuickBooks bill ${number} was already in QuickBooks and is now recorded (${money(billTotal)}).`
      : `QuickBooks bill ${number} created (${money(billTotal)}).`,
  };
}
