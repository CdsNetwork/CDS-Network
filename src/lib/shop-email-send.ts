import "server-only";
import { after } from "next/server";

/**
 * Sends the shop emails a CDS change just queued for this order (a dispatch, an extra work
 * decision, a note), once the server action has answered, so CDS never waits for Resend and an
 * email failure never undoes the change. Debounced line change emails are not due yet: the
 * cron sends them (src/app/api/cron/shop-emails/route.ts), as it sends anything this misses.
 */
export function emailShopAfter(workOrderId: string): void {
  after(async () => {
    try {
      // Loaded here, so importing an action module does not need the Supabase settings.
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { supabaseShopEmailStore } = await import("@/lib/shop-email-store");
      const { runShopEmails } = await import("@/lib/shop-email-run");
      await runShopEmails(supabaseShopEmailStore(createAdminClient()), { workOrderIds: [workOrderId], reminders: false, budgetMs: 20_000 });
    } catch (e) {
      console.error(`Shop email (work order ${workOrderId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
