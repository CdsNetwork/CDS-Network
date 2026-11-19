/**
 * The database side of the emails to shops (src/lib/shop-email-run.ts). Needs the service role
 * client: it reads every shop's contacts and writes public.shop_emails, which only CDS may read
 * and nobody but the service role may write (20261120200000_shop_emails.sql).
 *
 * It reads only what a shop already sees on its job page: the order's number, location, unit,
 * PO and fulfillment, the services and parts by name and quantity, a shared note, an extra work
 * request. Never a price, rate, margin or CDS-only table.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShopEmailKind } from "@/lib/shop-email";
import type { ReminderCandidate } from "@/lib/shop-email-reminders";
import { MAX_ATTEMPTS, type ShopEmailContext, type ShopEmailRow, type ShopEmailStore } from "@/lib/shop-email-run";

type One<T> = T | T[] | null;
const first = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
type Item = { sku: string | null; name: string | null };
/** "DPF-CLEAN DPF cleaning (note)": the SKU, name and line description as the shop's job page shows them. */
function itemName(i: Item | null, description?: string | null): string {
  const label = [i?.sku?.trim(), i?.name?.trim()].filter(Boolean).join(" ") || "Item";
  const extra = description?.trim();
  return extra ? `${label} (${extra.length > 120 ? `${extra.slice(0, 117)}...` : extra})` : label;
}

const DUE_WINDOW_MS = 48 * 3_600_000;

type DbRow = {
  id: number;
  work_order_id: string;
  affiliate_id: string;
  kind: ShopEmailKind;
  ref_id: string | null;
  since: string | null;
  created_at: string;
  dedupe_key: string;
};
const toRow = (r: DbRow): ShopEmailRow => ({
  id: r.id,
  workOrderId: r.work_order_id,
  affiliateId: r.affiliate_id,
  kind: r.kind,
  refId: r.ref_id,
  since: r.since,
  createdAt: r.created_at,
  dedupeKey: r.dedupe_key,
});

export function supabaseShopEmailStore(db: SupabaseClient): ShopEmailStore {
  return {
    async reminderCandidates(workOrderIds) {
      const { data, error } = await db.rpc("shop_email_reminder_candidates");
      if (error) throw new Error(`reminder candidates not read: ${error.message}`);
      const rows = (data ?? []) as Record<string, string | null>[];
      return rows
        .filter((r) => !workOrderIds || workOrderIds.includes(String(r.work_order_id)))
        .map(
          (r): ReminderCandidate => ({
            workOrderId: String(r.work_order_id),
            affiliateId: String(r.affiliate_id),
            status: String(r.status),
            fulfillment: String(r.fulfillment),
            enabledAt: r.enabled_at,
            dispatchedAt: r.dispatched_at,
            acceptedAt: r.accepted_at,
            pickedUpAt: r.picked_up_at,
            arrivedAt: r.arrived_at,
            lastShopUpdateAt: r.last_shop_update_at,
          }),
        );
    },

    async recordReminders(rows) {
      const { error } = await db.from("shop_emails").upsert(
        rows.map((r) => ({
          work_order_id: r.workOrderId,
          affiliate_id: r.affiliateId,
          kind: r.kind,
          dedupe_key: r.dedupeKey,
          since: r.since,
          status: r.status,
          note: r.note ?? null,
        })),
        { onConflict: "dedupe_key", ignoreDuplicates: true },
      );
      if (error) throw new Error(`reminders not recorded: ${error.message}`);
    },

    async dueRows(nowIso, workOrderIds, limit) {
      let query = db
        .from("shop_emails")
        .select("id, work_order_id, affiliate_id, kind, ref_id, since, created_at, dedupe_key")
        .in("status", ["pending", "error", "sending"])
        .or(`status.eq.pending,attempts.lt.${MAX_ATTEMPTS}`)
        .lte("send_after", nowIso)
        .gt("created_at", new Date(Date.parse(nowIso) - DUE_WINDOW_MS).toISOString())
        .order("id", { ascending: true })
        .limit(limit);
      if (workOrderIds) query = query.in("work_order_id", workOrderIds);
      const { data, error } = await query;
      if (error) throw new Error(`shop emails not read: ${error.message}`);
      return ((data ?? []) as DbRow[]).map(toRow);
    },

    async claim(id) {
      const { data, error } = await db.rpc("shop_email_claim", { p_id: id, p_max_attempts: MAX_ATTEMPTS });
      if (error) throw new Error(`shop email ${id} not claimed: ${error.message}`);
      return data === true;
    },

    async context(row) {
      const { data: wo, error } = await db
        .from("work_orders")
        .select("id, wo_number, status, affiliate_id, location_label, unit_number, po_number, fulfillment")
        .eq("id", row.workOrderId)
        .maybeSingle();
      if (error) throw new Error(`work order not read: ${error.message}`);
      if (!wo) return null;

      const [shopRead, contactsRead, linesRead] = await Promise.all([
        db.from("affiliates").select("display_name, shop_emails_enabled, is_in_house, active").eq("id", row.affiliateId).maybeSingle(),
        db.from("affiliate_contacts").select("email, receives_dispatch").eq("affiliate_id", row.affiliateId).order("email"),
        row.kind === "dispatch" || row.kind === "lines"
          ? db.from("work_order_lines").select("qty, description, created_at, catalog_items(sku, name)").eq("work_order_id", row.workOrderId).order("created_at")
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (shopRead.error) throw new Error(`shop not read: ${shopRead.error.message}`);
      if (contactsRead.error) throw new Error(`shop contacts not read: ${contactsRead.error.message}`);
      if (linesRead.error) throw new Error(`lines not read: ${linesRead.error.message}`);
      const shop = shopRead.data;
      if (!shop) return null;

      let note: ShopEmailContext["note"] = null;
      if (row.kind === "note" && row.refId) {
        const { data, error: nError } = await db.from("work_order_notes").select("author_name, body").eq("id", row.refId).maybeSingle();
        if (nError) throw new Error(`note not read: ${nError.message}`);
        if (data) note = { author: String(data.author_name ?? "CDS"), body: String(data.body ?? "") };
      }

      let extraWork: ShopEmailContext["extraWork"] = null;
      if ((row.kind === "extra_work_approved" || row.kind === "extra_work_declined") && row.refId) {
        const { data, error: rError } = await db.from("authorization_requests").select("qty, catalog_items(sku, name)").eq("id", row.refId).maybeSingle();
        if (rError) throw new Error(`extra work request not read: ${rError.message}`);
        if (data) extraWork = { item: itemName(first(data.catalog_items as One<Item>)), qty: Number(data.qty) };
      }

      return {
        order: {
          id: wo.id as string,
          woNumber: wo.wo_number as number,
          status: wo.status as string,
          affiliateId: (wo.affiliate_id as string | null) ?? null,
          location: (wo.location_label as string | null) ?? null,
          unitNumber: (wo.unit_number as string | null) ?? null,
          poNumber: (wo.po_number as string | null) ?? null,
          fulfillment: wo.fulfillment as string,
        },
        shop: {
          name: String(shop.display_name),
          emailsEnabled: Boolean(shop.shop_emails_enabled),
          inHouse: Boolean(shop.is_in_house),
          active: Boolean(shop.active),
        },
        contacts: (contactsRead.data ?? []).map((c) => ({ email: String(c.email), receivesDispatch: Boolean(c.receives_dispatch) })),
        note,
        extraWork,
        lines: ((linesRead.data ?? []) as { qty: number; description: string | null; catalog_items: One<Item> }[]).map((l) => ({
          item: itemName(first(l.catalog_items), l.description),
          qty: Number(l.qty),
        })),
      };
    },

    async finish(id, patch) {
      const { error } = await db
        .from("shop_emails")
        .update({ ...patch, note: patch.note ? patch.note.slice(0, 2000) : null })
        .eq("id", id);
      if (error) console.error(`Shop email ${id} not updated to ${patch.status}: ${error.message}`);
    },

    async skipDue(note, nowIso, workOrderIds) {
      let query = db.from("shop_emails").update({ status: "skipped", note }).eq("status", "pending").lte("send_after", nowIso);
      if (workOrderIds) query = query.in("work_order_id", workOrderIds);
      const { data, error } = await query.select("id");
      if (error) throw new Error(`shop emails not skipped: ${error.message}`);
      return data?.length ?? 0;
    },
  };
}
