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
      return r.work_order_id;
    },
  };
  return { store, rows, drafts };
}

