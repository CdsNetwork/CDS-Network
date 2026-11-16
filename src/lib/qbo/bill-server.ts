import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordSync } from "@/lib/integration-sync";
import type { BillRunDeps, BillRunResult } from "./bill-run";

/**
 * The shop's bill with the real database and QuickBooks (./bill-run). Runs with the service
 * role: the claim and finish functions are the server's only (20261118010000), and the
 * automatic run after a shop completes the job has no CDS login. Callers check who may ask
 * first: requireCds() for the button, the shop's own successful completion for the
 * automatic run.
 */

function deps(db: SupabaseClient, woId: string): BillRunDeps {
  return {
    load: async (id) => (await import("./bill-input")).loadBillInputs(db, id),
    claim: async (id) => {
      const { data, error } = await db.rpc("qbo_claim_shop_bill", { p_work_order: id });
      if (error) throw new Error(error.message);
      const c = data as { claim_id: string; request_id: string };
      return { claimId: c.claim_id, requestId: c.request_id };
    },
    finish: async (id, claimId, o) => {
      const { error } = await db.rpc("qbo_finish_shop_bill", {
        p_work_order: id,
        p_claim: claimId,
        p_outcome: o.outcome,
        p_bill_id: o.outcome === "created" ? o.billId : null,
        p_bill_number: o.outcome === "created" ? o.number : null,
        p_total: o.outcome === "created" ? o.total : null,
        p_vendor_id: o.outcome === "created" ? o.vendorId : null,
        p_error: o.outcome === "created" ? null : o.error,
      });
      if (error) throw new Error(error.message);
    },
    qbo: async (options) => {
      const [{ qboApi }, api] = await Promise.all([import("./tokens"), import("./api")]);
      const conn = await qboApi(options);
      return {
        findBills: (docNumber) => api.findBillsByNumber(conn, docNumber),
        createBill: (payload, requestId) => api.createBill(conn, payload, requestId),
      };
    },
    log: async (status, externalId, note) => {
      await recordSync(db, {
        system: "quickbooks",
        entity: "bill",
        entity_id: woId,
        external_id: externalId,
        direction: "push",
        status,
        error: note ? note.slice(0, 2000) : null,
      });
    },
  };
}

/** Creates (or retries) the shop's bill now. Never throws. */
export async function createShopBill(woId: string, mode: "auto" | "manual"): Promise<BillRunResult> {
  try {
    const [{ createAdminClient }, { runShopBill }] = await Promise.all([import("@/lib/supabase/admin"), import("./bill-run")]);
    return await runShopBill(deps(createAdminClient(), woId), woId, mode);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`QuickBooks shop bill (work order ${woId}, ${mode}): ${message}`);
    return { status: "failed", message: `The shop bill could not be created (${message}). Try again.` };
  }
}

/**
 * Creates the shop's bill once the action has answered (shop completion, the last TBD shop
 * rate entered), so the user never waits for QuickBooks and a QuickBooks failure can never
 * undo or block their change. Runs only when the order is ready and never had an attempt;
 * otherwise it does nothing. Call it only after the change succeeded.
 */
export function createShopBillAfter(woId: string): void {
  after(async () => {
    const r = await createShopBill(woId, "auto");
    if (r.status === "failed") console.error(`QuickBooks shop bill (work order ${woId}): ${r.message}`);
  });
}
