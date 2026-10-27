/** An in-memory IntakeStore that behaves like the database (unique message id, one order per email). */
import { randomUUID } from "node:crypto";
import type { DraftParams } from "@/lib/intake/draft";
import type { IntakeStatus, IntakeStore, StoredEmail } from "@/lib/intake/process";
import type { NormalizedEmail, ParsedEmail } from "@/lib/intake/types";
import { reference } from "./reference";

type Row = StoredEmail & { parsed: ParsedEmail | null; error: string | null };

export function memoryStore(options: { failDraft?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const drafts: DraftParams[] = [];
  /** The orders made, as the database keeps them (number, status, when). */
  const orders = new Map<string, { woNumber: number; status: string; createdAt: string; params: DraftParams }>();
  const store: IntakeStore = {
    async insertEmail(email: NormalizedEmail) {
      const existing = [...rows.values()].find((r) => r.email.messageId === email.messageId);
      if (existing) return { id: existing.id, inserted: false, status: existing.status, work_order_id: existing.work_order_id };
      const id = randomUUID();
      rows.set(id, { id, status: "new", work_order_id: null, attempts: 0, email, parsed: null, error: null });
      return { id, inserted: true, status: "new" as IntakeStatus, work_order_id: null };
    },
    async getEmail(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async reference() {
      return reference();
    },
    async saveResult(id, result) {
      const r = rows.get(id)!;
      if (r.work_order_id) return;
      Object.assign(r, result);
    },
    async createDraft(params) {
      if (options.failDraft) throw new Error("No customer price for catalog item");
      const r = rows.get(params.p_email)!;
      if (r.work_order_id) return r.work_order_id; // the database function returns the existing order
      drafts.push(params);
      r.work_order_id = randomUUID();
      r.status = "converted";
      r.error = null;
      orders.set(r.work_order_id, { woNumber: 101370 + orders.size, status: "pending_review", createdAt: r.email.receivedAt, params });
      return r.work_order_id;
    },
    async threadEmail(messageId) {
      const r = [...rows.values()].find((x) => x.email.messageId === messageId);
      if (!r) return null;
      const workOrderId = r.work_order_id ?? r.parsed?.thread_reference?.work_order_id ?? null;
      const order = workOrderId ? orders.get(workOrderId) : undefined;
      return {
        inReplyTo: r.email.inReplyTo ?? null,
        workOrderId: order ? workOrderId : null,
        woNumber: order?.woNumber ?? null,
        workOrderStatus: order?.status ?? null,
      };
    },
    async recentOrders(customerId, since) {
      return [...orders.entries()]
        .filter(([, o]) => o.params.p_customer === customerId && o.createdAt >= since && !["cancelled", "invoiced"].includes(o.status))
        .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt))
        .map(([id, o]) => ({
          id,
          woNumber: o.woNumber,
          locationId: o.params.p_location,
          unitNumber: o.params.p_unit_number,
          createdAt: o.createdAt,
          subject: rows.get(o.params.p_email)?.email.subject ?? null,
        }));
    },
  };
  return { store, rows, drafts, orders };
}

