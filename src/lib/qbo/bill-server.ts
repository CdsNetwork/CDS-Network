import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordSync } from "@/lib/integration-sync";
import type { BillRunDeps, BillRunResult } from "./bill-run";

/**
 * The shop's bill with the real database and QuickBooks (./bill-run). Runs with the service
 * role: the claim and finish functions are the server's only (20261118010000). The only
 * callers are CDS's Approve and send / Retry buttons, after requireCds(); the bill is never
 * sent on its own (CDS approves every bill, 2026-11-23).
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
      const [{ qboApi }, api, { cachedBillCustomFields }] = await Promise.all([import("./tokens"), import("./api"), import("./lists")]);
      const conn = await qboApi(options);
      return {
        findBills: (docNumber) => api.findBillsByNumber(conn, docNumber),
        getItems: (ids) => api.getItems(conn, ids),
        listDepartments: () => api.listDepartments(conn),
        listTerms: () => api.listTerms(conn),
        recentBillCustomFields: () => cachedBillCustomFields(conn),
        createBill: (payload, requestId) => api.createBill(conn, payload, requestId),
      };
    },
    saveDivision: async (customerId, division) => {
      // Insert only: a row CDS added or corrected meanwhile is kept.
      const { error } = await db
        .from("qbo_customer_cogs_division")
        .upsert(
          { customer_id: customerId, qbo_department_id: division.id, qbo_department_name: division.name },
          { onConflict: "customer_id", ignoreDuplicates: true },
        );
      if (error) console.error(`qbo_customer_cogs_division: could not remember ${division.name} for customer ${customerId}: ${error.message}`);
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

/** Creates (or retries) the shop's bill now, once CDS approved it. Never throws. */
export async function createShopBill(woId: string): Promise<BillRunResult> {
  try {
    const [{ createAdminClient }, { runShopBill }] = await Promise.all([import("@/lib/supabase/admin"), import("./bill-run")]);
    return await runShopBill(deps(createAdminClient(), woId), woId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`QuickBooks shop bill (work order ${woId}): ${message}`);
    return { status: "failed", message: `The shop bill could not be created (${message}). Try again.` };
  }
}
