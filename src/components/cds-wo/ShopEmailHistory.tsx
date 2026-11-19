import { dateTime } from "@/lib/format";
import { SHOP_EMAIL_KIND_LABEL, type ShopEmailKind } from "@/lib/shop-email";
import { createClient } from "@/lib/supabase/server";

type Row = {
  id: number;
  kind: ShopEmailKind;
  status: string;
  recipients: string[] | null;
  note: string | null;
  created_at: string;
  sent_at: string | null;
  affiliates: { display_name: string } | { display_name: string }[] | null;
};

const STATUS: Record<string, { label: string; tag: string }> = {
  sent: { label: "Sent", tag: "tag green" },
  pending: { label: "Waiting", tag: "tag" },
  sending: { label: "Sending", tag: "tag" },
  error: { label: "Failed", tag: "tag amber" },
  skipped: { label: "Not sent", tag: "tag" },
};

/**
 * "Emails to shop" on the work order page (CDS only: shops cannot read public.shop_emails):
 * the notices and reminders the portal sent, or did not send and why, newest first.
 */
export async function ShopEmailHistory({ workOrderId }: { workOrderId: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shop_emails")
    .select("id, kind, status, recipients, note, created_at, sent_at, affiliates(display_name)")
    .eq("work_order_id", workOrderId)
    .order("id", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Row[];
  return (
    <section className="section" id="shop-emails">
      <h3>Emails to shop</h3>
      {error ? (
        <div className="notice danger">The emails to the shop could not be loaded. Reload the page.</div>
      ) : rows.length === 0 ? (
        <p className="small">No emails to the shop about this order. Shops get them only when CDS turns them on in Admin &gt; Shops.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r) => {
            const shop = (Array.isArray(r.affiliates) ? r.affiliates[0] : r.affiliates)?.display_name;
            const status = STATUS[r.status] ?? { label: r.status, tag: "tag" };
            return (
              <div key={r.id} className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                <span className="small nowrap" style={{ minWidth: 150 }}>
                  {dateTime(r.sent_at ?? r.created_at)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {SHOP_EMAIL_KIND_LABEL[r.kind] ?? r.kind}
                  {shop && <span className="small"> ({shop})</span>}
                  {r.status === "sent" && r.recipients?.length ? (
                    <div className="small" style={{ overflowWrap: "anywhere" }}>
                      To: {r.recipients.join(", ")}
                    </div>
                  ) : null}
                  {r.status !== "sent" && r.note && <div className="small">{r.note}</div>}
                </span>
                <span className={status.tag}>{status.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
