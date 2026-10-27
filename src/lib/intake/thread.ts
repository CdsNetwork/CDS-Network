/**
 * Replies and forwards of a request that already has a work order. A Ryder request is answered
 * on its thread by CDS dispatch, the Ryder location and the shop; a reply that quotes the
 * whole form reads as the same request again and must not make a second draft.
 *
 * The order is found by the thread first: the In-Reply-To header, followed up through the
 * stored emails (CDS's own answers are stored as ignored), to the email that made an order or
 * was already linked to one. Without a stored thread, a recent open order of the same customer
 * is taken when it has the same location and unit, or the same subject (without Re:, Fw:) and
 * no other unit. A new request (not a reply) always makes its own draft: Ryder sends one
 * request per unit, often with the same subject.
 */
import type { IntakeStore } from "./process";
import type { NormalizedEmail, ParsedEmail, ThreadReference } from "./types";

/** How long after a request a reply without a stored thread is still matched to its order. */
export const THREAD_WINDOW_DAYS = 14;
const MAX_HOPS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const PREFIX = /^\s*(?:(?:re|fwd?|fw)\s*:|\[external\]\s*-?)\s*/i;

/** A reply or forward: "Re:", "RE:", "Fw:", "Fwd:" before the subject, or an In-Reply-To header. */
export function isReplyOrForward(email: Pick<NormalizedEmail, "subject" | "inReplyTo">): boolean {
  return !!email.inReplyTo || /^\s*(?:\[external\]\s*-?\s*)?(?:re|fwd?|fw)\s*:/i.test(email.subject);
}

/** The subject without reply and forward prefixes, stars, case and extra spaces. */
export function subjectKey(subject: string | null | undefined): string {
  let s = subject ?? "";
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(PREFIX, "");
  }
  return s.replace(/\*+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

const unitKey = (unit: string | null | undefined) => {
  const k = (unit ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return k && k !== "NOTGIVEN" ? k : null;
};

export async function findThreadOrder(store: IntakeStore, email: NormalizedEmail, parsed: ParsedEmail): Promise<ThreadReference | null> {
  // 1. The thread, through the stored emails.
  if (store.threadEmail) {
    const visited = new Set<string>();
    for (let id = email.inReplyTo ?? null, hops = 0; id && !visited.has(id) && hops < MAX_HOPS; hops++) {
      visited.add(id);
      const parent = await store.threadEmail(id);
      if (!parent) break;
      if (parent.workOrderId && parent.workOrderStatus !== "cancelled") {
        return { work_order_id: parent.workOrderId, wo_number: parent.woNumber, via: "thread" };
      }
      id = parent.inReplyTo;
    }
  }

  // 2. A recent open order of the same customer.
  const customerId = parsed.customer?.id;
  if (!customerId || !store.recentOrders) return null;
  const received = Date.parse(email.receivedAt);
  const since = new Date((Number.isNaN(received) ? Date.now() : received) - THREAD_WINDOW_DAYS * DAY_MS).toISOString();
  const orders = await store.recentOrders(customerId, since);
  const unit = unitKey(parsed.fields.unit_number.value);
  const locationId = parsed.location?.id ?? null;
  const byUnit = unit && locationId ? orders.find((o) => o.locationId === locationId && unitKey(o.unitNumber) === unit) : undefined;
  if (byUnit) return { work_order_id: byUnit.id, wo_number: byUnit.woNumber, via: "unit" };
  const key = subjectKey(email.subject);
  const bySubject = key
    ? orders.find((o) => subjectKey(o.subject) === key && (!unit || !unitKey(o.unitNumber) || unitKey(o.unitNumber) === unit))
    : undefined;
  return bySubject ? { work_order_id: bySubject.id, wo_number: bySubject.woNumber, via: "subject" } : null;
}
