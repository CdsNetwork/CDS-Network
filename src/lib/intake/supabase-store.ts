import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emailAddress, intakeMailbox } from "./email";
import { pacificToday } from "@/lib/dates";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { IntakeStatus, IntakeStore, StoredEmail } from "./process";
import { splitCatalog, type AliasRef, type CatalogRef, type CustomerRef, type DomainRef, type IntakeReference, type LocationRef, type NormalizedEmail } from "./types";

type EmailRow = {
  id: string;
  status: IntakeStatus;
  work_order_id: string | null;
  attempts: number;
  provider_message_id: string;
  from_header: string | null;
  from_address: string | null;
  to_addresses: string[] | null;
  subject: string | null;
  received_at: string;
  body_text: string | null;
  body_html: string | null;
  attachments: NormalizedEmail["attachments"] | null;
  mailbox: string | null;
  in_reply_to: string | null;
};

/**
 * The intake store on Supabase. The webhook passes the service role client (no user session);
 * the /cds/intake page passes the signed-in CDS user's client, so RLS applies there.
 */
export function supabaseIntakeStore(client: SupabaseClient, actorId: string | null = null): IntakeStore {
  return {
    async insertEmail(email, source) {
      const row = {
        mailbox: intakeMailbox(email),
        in_reply_to: email.inReplyTo ?? null,
        provider_message_id: email.messageId,
        received_at: email.receivedAt,
        from_header: email.from,
        from_address: emailAddress(email.from),
        to_addresses: email.to,
        subject: email.subject,
        body_text: email.text,
        body_html: email.html,
        attachments: email.attachments,
        source,
        created_by: actorId,
        status: "new",
      };
      const { data, error } = await client
        .from("inbound_emails")
        .upsert(row, { onConflict: "provider_message_id", ignoreDuplicates: true })
        .select("id, status, work_order_id");
      if (error) throw new Error(error.message);
      if (data && data.length) return { ...(data[0] as { id: string; status: IntakeStatus; work_order_id: string | null }), inserted: true };
      const existing = await client
        .from("inbound_emails")
        .select("id, status, work_order_id")
        .eq("provider_message_id", email.messageId)
        .single();
      if (existing.error) throw new Error(existing.error.message);
      return { ...(existing.data as { id: string; status: IntakeStatus; work_order_id: string | null }), inserted: false };
    },

    async getEmail(id): Promise<StoredEmail | null> {
      const { data, error } = await client
        .from("inbound_emails")
        .select(
          "id, status, work_order_id, attempts, provider_message_id, from_header, from_address, to_addresses, subject, received_at, body_text, body_html, attachments, mailbox, in_reply_to",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const r = data as EmailRow;
      return {
        id: r.id,
        status: r.status,
        work_order_id: r.work_order_id,
        attempts: r.attempts,
        email: {
          messageId: r.provider_message_id,
          from: r.from_header ?? r.from_address ?? "",
          to: r.to_addresses ?? [],
          subject: r.subject ?? "",
          receivedAt: r.received_at,
          text: r.body_text,
          html: r.body_html,
          attachments: r.attachments ?? [],
          inReplyTo: r.in_reply_to,
          deliveredTo: r.mailbox,
        },
      };
    },

    async reference(): Promise<IntakeReference> {
      const [customers, domains, catalog, aliases] = await Promise.all([
        fetchAll<CustomerRef>((a, b) => client.from("customers").select("id, code, name").eq("active", true).order("id").range(a, b)),
        fetchAll<DomainRef>((a, b) => client.from("customer_email_domains").select("customer_id, domain").order("id").range(a, b)),
        // Items priced per line (Misc. hardware) need an amount from the shop's invoice, so
        // intake never proposes them; they are kept apart only to warn when one is asked for.
        fetchAll<CatalogRef>((a, b) =>
          client
            .from("catalog_items")
            .select("id, sku, name, category, oe_cross, price_per_line")
            .eq("active", true)
            .order("id")
            .range(a, b),
        ).then(splitCatalog),
        fetchAll<AliasRef>((a, b) =>
          client.from("customer_item_aliases").select("customer_id, catalog_item_id, customer_part_number").order("id").range(a, b),
        ),
      ]);
      const cache = new Map<string, Promise<LocationRef[]>>();
      const today = pacificToday();
      const current = `effective_to.is.null,effective_to.gt.${today}`;
      return {
        customers,
        domains,
        ...catalog,
        aliases,
        // The price in effect today, Pacific date: the customer's own, else the fleet price.
        async priceFor(customerId, catalogItemId) {
          const own = await client
            .from("customer_price_overrides")
            .select("amount")
            .eq("customer_id", customerId)
            .eq("catalog_item_id", catalogItemId)
            .eq("market", "US")
            .lte("effective_from", today)
            .or(current)
            .order("effective_from", { ascending: false })
            .limit(1);
          if (own.error) throw new Error(own.error.message);
          if (own.data?.length) return Number((own.data[0] as { amount: number }).amount);
          const fleet = await client
            .from("sell_prices")
            .select("amount")
            .eq("catalog_item_id", catalogItemId)
            .eq("market", "US")
            .lte("effective_from", today)
            .or(current)
            .order("effective_from", { ascending: false })
            .limit(1);
          if (fleet.error) throw new Error(fleet.error.message);
          return fleet.data?.length ? Number((fleet.data[0] as { amount: number }).amount) : null;
        },
        locationsFor(customerId) {
          if (!cache.has(customerId)) {
            cache.set(
              customerId,
              fetchAll<LocationRef>((a, b) =>
                client
                  .from("customer_locations")
                  .select("id, customer_id, code, location_number, name, address_raw, city, region, postal_code, fulfillment")
                  .eq("customer_id", customerId)
                  .eq("active", true)
                  .order("id")
                  .range(a, b),
              ),
            );
          }
          return cache.get(customerId)!;
        },
      };
    },

    async saveResult(id, result) {
      const parser = result.parsed ? (result.parsed.llm.used ? `rules+${result.parsed.llm.model}` : "rules") : null;
      const { error } = await client
        .from("inbound_emails")
        .update({
          status: result.status,
          parsed: result.parsed,
          confidence: result.parsed?.confidence ?? null,
          parser,
          error: result.error,
          attempts: result.attempts,
          processed_at: new Date().toISOString(),
        })
        .eq("id", id)
        .is("work_order_id", null);
      if (error) throw new Error(error.message);
    },

    async notePoReference(id, poNumber) {
      const { data, error } = await client.rpc("intake_note_po_reference", { p_email: id, p_po: poNumber });
      if (error) throw new Error(error.message);
      const row = (data as { work_order_id: string; wo_number: number }[] | null)?.[0];
      return row ? { workOrderId: row.work_order_id, woNumber: Number(row.wo_number) } : null;
    },

    async createDraft(params) {
      const { data, error } = await client.rpc("intake_create_draft_work_order", params);
      if (error || !data) throw new Error(error?.message ?? "The draft work order could not be created.");
      return data as string;
    },
  };
}
