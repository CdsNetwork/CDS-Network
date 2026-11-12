/**
 * The database side of the status emails (src/lib/portal-email.ts). Needs the service role
 * client: shops cannot read customers' names or write integration_sync, and the email is sent
 * after the shop's own status change succeeded.
 *
 * Key of a status change: "<event>:<shop>:<anchor>", where anchor is the id of the last work
 * order event before the change that is of another kind. A double clicked or retried dispatch
 * logs a second 'dispatch' event with the same anchor and shop, so it gets the same key and is
 * emailed once; a dispatch after a decline (or to another shop) gets a new key.
 *
 * A failure ("failed") is keyed on its component_failures row ("failed:<id>"): the latest
 * failure of the saved component. Saving a failed component again records no new failure, so
 * it gets the same key and is emailed once.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickupWindowLabel } from "@/lib/format";
import type { PortalEmailDetails, PortalEmailStore, PortalEvent } from "./portal-email";

/** The work_order_events.event_type each status change logs (database functions). */
export const PORTAL_EVENT_TYPE: Record<Exclude<PortalEvent, "failed">, string> = {
  sent: "dispatch",
  declined: "decline",
  finished: "complete",
  accepted: "accept",
};

const ENTITY = "portal_email";

type One<T> = T | T[] | null;
const first = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

const RESULT_LABEL: Record<string, string> = { condemned: "Condemned" };

/** "DPF, part 2871891, serial SN-4471" (the parts that are known). */
export function componentLabel(c: { component_type: string; manufacturer?: string | null; part_number?: string | null; serial_number?: string | null }): string {
  return [
    c.component_type,
    c.manufacturer?.trim() || null,
    c.part_number?.trim() ? `part ${c.part_number.trim()}` : null,
    c.serial_number?.trim() ? `serial ${c.serial_number.trim()}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The pickup ETA / window the acceptance email gives: the window the shop chose on a pickup
 * job, null on a shipping job (it has no pickup ETA).
 */
export function acceptedEta(pickupWindow: string | null | undefined): string | null {
  return pickupWindow ? pickupWindowLabel(pickupWindow) : null;
}

export function supabasePortalEmailStore(db: SupabaseClient): PortalEmailStore {
  return {
    async details(event, workOrderId, componentId) {
      const { data: wo, error: woError } = await db
        .from("work_orders")
        .select("id, wo_number, location_label, unit_number, po_number, affiliate_id, affiliate_invoice_ref, pickup_window, customers(name), affiliates(display_name)")
        .eq("id", workOrderId)
        .maybeSingle();
      if (woError) throw new Error(`work order not read: ${woError.message}`);
      if (!wo) return null;
      const shop = first(wo.affiliates as One<{ display_name: string }>)?.display_name ?? null;
      const base = {
        workOrderId,
        woNumber: wo.wo_number,
        customer: first(wo.customers as One<{ name: string }>)?.name ?? null,
        location: wo.location_label ?? null,
        unitNumber: wo.unit_number ?? null,
        poNumber: wo.po_number ?? null,
        shop,
      };

      if (event === "failed") {
        if (!componentId) return null;
        const { data: failure, error: fError } = await db
          .from("component_failures")
          .select("id, at, component_type, manufacturer, part_number, serial_number, result, result_note, affiliates(display_name)")
          .eq("work_order_id", workOrderId)
          .eq("component_id", componentId)
          .order("at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (fError) throw new Error(`component failure not read: ${fError.message}`);
        if (!failure) return null;
        const failedShop = first(failure.affiliates as One<{ display_name: string }>)?.display_name ?? shop;
        const details: PortalEmailDetails = {
          ...base,
          shop: failedShop,
          at: failure.at,
          declineReason: null,
          shopReference: null,
          component: componentLabel(failure),
          result: RESULT_LABEL[failure.result] ?? failure.result,
          failureNote: failure.result_note ?? null,
        };
        return { ...details, key: `failed:${failure.id}` };
      }

      const type = PORTAL_EVENT_TYPE[event];
      const { data: change, error: evError } = await db
        .from("work_order_events")
        .select("id, at, message")
        .eq("work_order_id", workOrderId)
        .eq("event_type", type)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (evError) throw new Error(`work order event not read: ${evError.message}`);
      if (!change) return null;

      const { data: anchor, error: anchorError } = await db
        .from("work_order_events")
        .select("id")
        .eq("work_order_id", workOrderId)
        .neq("event_type", type)
        .lt("id", change.id)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (anchorError) throw new Error(`work order events not read: ${anchorError.message}`);

      const message = String(change.message ?? "");
      const prefix = `Declined by ${shop ?? ""}: `;
      const details: PortalEmailDetails = {
        ...base,
        at: change.at,
        declineReason: event === "declined" ? (message.startsWith(prefix) ? message.slice(prefix.length) : message) || null : null,
        shopReference: wo.affiliate_invoice_ref ?? null,
        eta: event === "accepted" ? acceptedEta(wo.pickup_window) : null,
      };
      return { ...details, key: `${event}:${wo.affiliate_id ?? "none"}:${anchor?.id ?? 0}` };
    },

    async claim(_event, workOrderId, key) {
      const { data: mine, error } = await db
        .from("integration_sync")
        .insert({ system: "email", entity: ENTITY, entity_id: workOrderId, external_id: key, direction: "push", status: "sending" })
        .select("id")
        .single();
      if (error || !mine) throw new Error(`integration_sync claim not written: ${error?.message ?? "no row"}`);
      // The earliest row for this change wins; a later one (double click, retry) stands down.
      const { data: earliest, error: readError } = await db
        .from("integration_sync")
        .select("id")
        .eq("system", "email")
        .eq("entity", ENTITY)
        .eq("entity_id", workOrderId)
        .eq("external_id", key)
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (readError) throw new Error(`integration_sync claim not read: ${readError.message}`);
      if (earliest && earliest.id !== mine.id) {
        await db.from("integration_sync").update({ status: "duplicate", error: `Already emailed (row ${earliest.id}).` }).eq("id", mine.id);
        return null;
      }
      return { rowId: mine.id as number };
    },

    async finish(rowId, status, note) {
      const { error } = await db
        .from("integration_sync")
        .update({ status, error: note ? note.slice(0, 2000) : null })
        .eq("id", rowId);
      if (error) console.error(`Portal email: integration_sync row ${rowId} not updated to ${status}: ${error.message}`);
    },
  };
}
