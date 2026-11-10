import "server-only";
import { after } from "next/server";
import { notifyWorkOrderEvent, type PortalEvent } from "@/lib/portal-email";
import { supabasePortalEmailStore } from "@/lib/portal-email-store";

/**
 * Emails CDS about a status change once the server action has answered, so the user never
 * waits for Resend and an email failure can never undo or block the change. Call it only
 * after the change succeeded.
 */
export function emailCdsAfter(event: PortalEvent, workOrderId: string, componentId?: string): void {
  after(async () => {
    try {
      // Loaded here, so importing an action module does not need the Supabase settings.
      const { createAdminClient } = await import("@/lib/supabase/admin");
      await notifyWorkOrderEvent(event, workOrderId, { store: supabasePortalEmailStore(createAdminClient()), componentId });
    } catch (e) {
      console.error(`Portal email (${event}, work order ${workOrderId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
