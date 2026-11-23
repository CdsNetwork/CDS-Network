import "server-only";
import { recordSync } from "@/lib/integration-sync";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { billNumberInQuickBooks } from "./bill-number-check";

/** Statuses the shop may complete from (private.shop_can_edit); others are refused by the database anyway. */
const COMPLETABLE = ["accepted", "picked_up", "in_process"];

/**
 * The QuickBooks side of the duplicate bill number rule (./bill-number-check) with the real
 * database and QuickBooks. Call it only after requireShop(): the order is read with the shop's
 * own client, so RLS proves it is this shop's; the vendor link (CDS-only table) and the
 * QuickBooks tokens are read with the service role, like the automatic shop bill
 * (./qbo/bill-server). Never throws: anything unexpected is logged and does not block.
 */
export async function quickBooksBillNumberError(workOrderId: string, ref: string): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data: wo, error } = await supabase
      .from("work_orders")
      .select("id, wo_number, status, affiliate_id")
      .eq("id", workOrderId)
      .maybeSingle();
    if (error) throw new Error(`the work order could not be read: ${error.message}`);
    if (!wo || !wo.affiliate_id || !COMPLETABLE.includes(wo.status as string)) return null;

    const admin = createAdminClient();
    return await billNumberInQuickBooks(
      {
        vendorFor: async (affiliateId) => {
          const { data, error: linkError } = await admin
            .from("qbo_affiliate_vendor")
            .select("qbo_vendor_id, qbo_vendor_name")
            .eq("affiliate_id", affiliateId)
            .maybeSingle();
          if (linkError) throw new Error(linkError.message);
          return data ? { id: String(data.qbo_vendor_id), name: String(data.qbo_vendor_name) } : null;
        },
        findBills: async (docNumber) => {
          const [{ qboApi }, { findBillsByNumber }] = await Promise.all([import("./qbo/tokens"), import("./qbo/api")]);
          return findBillsByNumber(await qboApi(), docNumber);
        },
        log: async (note) => {
          console.warn(`Work order ${workOrderId}: ${note}`);
          await recordSync(admin, {
            system: "quickbooks",
            entity: "bill_number_check",
            entity_id: workOrderId,
            direction: "pull",
            status: "skipped",
            error: note.slice(0, 2000),
          });
        },
      },
      { ref, affiliateId: wo.affiliate_id as string, woNumber: Number(wo.wo_number) },
    );
  } catch (e) {
    console.error(`Work order ${workOrderId}: QuickBooks bill number check skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
