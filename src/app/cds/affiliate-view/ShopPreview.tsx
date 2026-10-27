import "server-only";
import { StatusBadge } from "@/components/StatusBadge";
import styles from "@/components/cds-wo/cds-wo.module.css";
import { one } from "@/components/cds-wo/util";
import {
  ATTACHMENT_CATEGORY_LABEL,
  COMPONENT_RESULT_LABEL,
  date,
  dateTime,
  DIRECTION_LABEL,
  FULFILLMENT_LABEL,
  money,
  pickupWindowLabel,
  SHIP_STATUS_LABEL,
  SHIPMENT_STATUS_LABEL,
  SHOP_STATUS_LABEL,
  STATUS_LABEL,
  woLabel,
  type WoStatus,
} from "@/lib/format";
import type { createClient } from "@/lib/supabase/server";

// Read-only copy of the shop job screen for CDS. The CDS client can read everything, so
// every query below selects only the columns the shop portal itself reads
// (src/app/shop/data.ts) and repeats the shop row filters of the RLS policies:
// - the order is assigned to this shop and is not pending_review / rejected_by_affiliate
// - components, extra work requests and attachments: no shop, or this shop
// - attachments: shop_visible only
// - history: shop_visible and stamped with this shop
// Never selected here: customer prices, margins, overrides, CDS notes, decision notes,
// customer approver names, shipment costs or notes, another shop's rows.

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Item = { sku: string; name: string } | { sku: string; name: string }[] | null;

const HIDDEN = "(pending_review,rejected_by_affiliate)";

const ORIGIN_LABEL: Record<string, string> = {
  cds_order: "Ordered by CDS",
  auth_request: "Approved extra work",
  shop_added: "Added by your shop",
};

const AUTH_STATUS_LABEL: Record<string, string> = {
  pending: "Pending CDS Approval",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

type Job = {
  id: string;
  wo_number: number;
  status: WoStatus;
  fulfillment: string;
  location_label: string;
  site_address: string | null;
  unit_number: string | null;
  po_number: string | null;
  requested_work: string;
  pickup_window: string | null;
  shop_ship_status: string | null;
  affiliate_invoice_ref: string | null;
  completed_at: string | null;
  customers: { name: string } | { name: string }[] | null;
};

type PreviewLine = {
  id: string;
  qty: number;
  shop_unit_rate: number | null;
  origin: string;
  description: string | null;
  catalog_items: Item;
};
type PreviewComponent = {
  id: string;
  seq: number;
  component_type: string;
  manufacturer: string | null;
  part_number: string | null;
  serial_number: string | null;
  dp_before: number | null;
  dp_after: number | null;
  weight_before_g: number | null;
  weight_after_g: number | null;
  result: string | null;
  result_note: string | null;
};
type PreviewRequest = { id: string; seq: number; kind: string; qty: number; note: string; status: string; requested_at: string; catalog_items: Item };
type PreviewFile = {
  id: string;
  component_id: string | null;
  category: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  note: string | null;
  uploaded_at: string;
};
type PreviewShipment = { id: string; direction: string; carrier: string | null; tracking_number: string | null; status: string };
type PreviewEvent = { id: number; at: string; message: string; to_status: WoStatus | null };

export type PreviewData = {
  job: Job;
  lines: PreviewLine[];
  components: PreviewComponent[];
  requests: PreviewRequest[];
  files: (PreviewFile & { url: string | null })[];
  shipments: PreviewShipment[];
  events: PreviewEvent[];
};

/** The job as the given shop sees it, or null when the shop cannot see it. */
export async function loadPreview(supabase: Supabase, shopId: string, woId: string): Promise<PreviewData | null> {
  const { data: wo } = await supabase
    .from("work_orders")
    .select(
      "id, wo_number, status, fulfillment, location_label, site_address, unit_number, po_number, " +
        "requested_work, pickup_window, shop_ship_status, affiliate_invoice_ref, completed_at, customers(name)",
    )
    .eq("id", woId)
    .eq("affiliate_id", shopId)
    .not("status", "in", HIDDEN)
    .maybeSingle();
  if (!wo) return null;
  const job = wo as unknown as Job;
  const ownOrNone = `affiliate_id.is.null,affiliate_id.eq.${shopId}`;

  const [lines, components, requests, files, shipments, events] = await Promise.all([
    supabase
      .from("work_order_lines")
      .select("id, qty, shop_unit_rate, origin, description, catalog_items(sku, name)")
      .eq("work_order_id", woId)
      .order("created_at"),
    supabase
      .from("work_order_components")
      .select(
        "id, seq, component_type, manufacturer, part_number, serial_number, dp_before, dp_after, " +
          "weight_before_g, weight_after_g, result, result_note",
      )
      .eq("work_order_id", woId)
      .or(ownOrNone)
      .order("seq"),
    supabase
      .from("authorization_requests")
      .select("id, seq, kind, qty, note, status, requested_at, catalog_items(sku, name)")
      .eq("work_order_id", woId)
      .or(ownOrNone)
      .order("seq"),
    supabase
      .from("attachments")
      .select("id, component_id, category, storage_path, file_name, mime_type, note, uploaded_at")
      .eq("work_order_id", woId)
      .eq("shop_visible", true)
      .or(ownOrNone)
      .order("uploaded_at"),
    supabase
      .from("shipments")
      .select("id, direction, carrier, tracking_number, status")
      .eq("work_order_id", woId)
      .order("created_at"),
    supabase
      .from("work_order_events")
      .select("id, at, message, to_status")
      .eq("work_order_id", woId)
      .eq("shop_visible", true)
      .eq("affiliate_id", shopId)
      .order("at"),
  ]);

  const fileRows = (files.data ?? []) as PreviewFile[];
  const urls = new Map<string, string>();
  if (fileRows.length) {
    const { data: signed } = await supabase.storage.from("wo-files").createSignedUrls(
      fileRows.map((f) => f.storage_path),
      600,
    );
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }

  return {
    job,
    lines: ((lines.data ?? []) as unknown as PreviewLine[]).map((l) => ({
      ...l,
      qty: Number(l.qty),
      shop_unit_rate: l.shop_unit_rate === null ? null : Number(l.shop_unit_rate),
    })),
    components: (components.data ?? []) as unknown as PreviewComponent[],
    requests: (requests.data ?? []) as unknown as PreviewRequest[],
    files: fileRows.map((f) => ({ ...f, url: urls.get(f.storage_path) ?? null })),
    shipments: (shipments.data ?? []) as PreviewShipment[],
    events: (events.data ?? []) as PreviewEvent[],
  };
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="small">{label}</div>
      <div style={{ whiteSpace: "pre-wrap" }}>{value || "-"}</div>
    </div>
  );
}

export function ShopPreview({ data }: { data: PreviewData }) {
  const { job, lines, components, requests, files, shipments, events } = data;
  const customer = one(job.customers)?.name ?? "";
  const isPickup = job.fulfillment === "pickup";
  const isShipping = job.fulfillment === "shipping";
  const settlement = lines.reduce((sum, l) => sum + (l.shop_unit_rate ?? 0) * l.qty, 0);
  const componentName = new Map(components.map((c) => [c.id, `${c.component_type} #${c.seq}`]));

  return (
    <div>
      <div className="hero">
        <div className="small" style={{ fontWeight: 800, letterSpacing: "0.05em" }}>
          CDS NETWORK WORK ORDER
        </div>
        <h2>
          {woLabel(job.wo_number)} · {customer} - {job.location_label}
        </h2>
        <div>
          Unit {job.unit_number ?? "-"} · PO {job.po_number || "-"}
        </div>
        {job.site_address && (
          <div className="small" style={{ marginTop: 4 }}>
            {job.site_address}
          </div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          {isShipping ? (
            <span className="tag blue">📦 Shipping</span>
          ) : isPickup ? (
            <span className="tag green">🚚 Pickup / Delivery</span>
          ) : (
            <span className="tag">{FULFILLMENT_LABEL[job.fulfillment] ?? job.fulfillment}</span>
          )}
          <StatusBadge status={job.status} shop />
        </div>
        {isShipping && (
          <div className="notice" style={{ background: "#fff" }}>
            <strong>LOGISTICS: SHIPPING</strong>
            <div>Do not schedule a local pickup. Use the CDS-provided shipping label(s) for this job.</div>
            {shipments.length === 0 && <p className="small">CDS has not added a shipment yet.</p>}
            {shipments.map((s) => (
              <div key={s.id} className="routebox" style={{ marginTop: 10 }}>
                <div className="row between">
                  <strong>{DIRECTION_LABEL[s.direction] ?? s.direction}</strong>
                  <span className="pill">{SHIPMENT_STATUS_LABEL[s.status] ?? s.status}</span>
                </div>
                <div className="small" style={{ marginTop: 4 }}>
                  {s.carrier ?? "Carrier not set"}
                </div>
                <div style={{ fontWeight: 850, color: "var(--blue)" }}>{s.tracking_number || "Tracking number not added yet"}</div>
              </div>
            ))}
          </div>
        )}
        {isPickup && (
          <div className="notice" style={{ background: "#fff" }}>
            <strong>LOGISTICS: AFFILIATE PICKUP</strong>
            <div>Affiliate is responsible for pickup from the customer location.</div>
          </div>
        )}
        {job.status === "cancelled" && <div className="notice danger">CDS cancelled this job. No further work is needed.</div>}
      </div>

      <div className="grid2">
        <section className="section" style={{ marginTop: 0 }}>
          <h3>Job</h3>
          <div className="routebox" style={{ display: "grid", gap: 8 }}>
            <Fact label="Requested work" value={job.requested_work} />
            <Fact
              label="Fulfillment"
              value={isShipping ? "Carrier shipment" : isPickup ? "Affiliate pickup / local delivery" : FULFILLMENT_LABEL[job.fulfillment]}
            />
            {isPickup && <Fact label="Pickup ETA / Window" value={job.pickup_window ? pickupWindowLabel(job.pickup_window) : "Not accepted yet"} />}
            {isShipping && (
              <Fact label="Shipping workflow status" value={job.shop_ship_status ? SHIP_STATUS_LABEL[job.shop_ship_status] : "Not set"} />
            )}
            <Fact label="Affiliate Invoice / Reference #" value={job.affiliate_invoice_ref} />
            {job.completed_at && <Fact label="Completed" value={date(job.completed_at)} />}
          </div>
        </section>
        <section className="section" style={{ marginTop: 0 }}>
          <h3>Settlement preview</h3>
          <div className="bigAmount">{money(settlement)}</div>
          <p className="small">Calculated from CDS-controlled affiliate rates. Customer pricing is not shown.</p>
        </section>
      </div>

      <section className="section">
        <h3>Services &amp; Parts</h3>
        {lines.length === 0 && <p className="small">No services or parts on this job yet.</p>}
        {lines.map((l) => {
          const item = one(l.catalog_items);
          return (
            <div key={l.id} className={styles.lineRow}>
              <div style={{ minWidth: 0 }}>
                <strong>{item?.sku}</strong>
                <div>{item?.name}</div>
                {l.description && <div className="small">{l.description}</div>}
                <div className="small">{ORIGIN_LABEL[l.origin] ?? l.origin}</div>
              </div>
              <div className={styles.lineMoney}>
                <div className="small">
                  {l.qty} x {money(l.shop_unit_rate)}
                </div>
                <div className="money">{l.shop_unit_rate === null ? "-" : money(l.shop_unit_rate * l.qty)}</div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="section">
        <h3>Components Received</h3>
        {components.length === 0 && <p className="small">No components added yet.</p>}
        {components.map((c) => {
          const isEgr = c.component_type === "EGR";
          const rows: [string, string][] = [
            ["Manufacturer", c.manufacturer ?? "-"],
            ["Part Number", c.part_number ?? "-"],
            ["Serial Number", c.serial_number ?? "-"],
          ];
          if (!isEgr) {
            const before = c.weight_before_g === null ? null : Number(c.weight_before_g);
            const after = c.weight_after_g === null ? null : Number(c.weight_after_g);
            rows.push(
              ["Differential Pressure: Before", c.dp_before?.toString() ?? "-"],
              ["Differential Pressure: After", c.dp_after?.toString() ?? "-"],
              ["Weight Before (g)", before?.toString() ?? "-"],
              ["Weight After (g)", after?.toString() ?? "-"],
              ["Weight Removed", before !== null && after !== null ? `${Math.round((before - after) * 10) / 10} g` : "-"],
            );
          }
          rows.push([
            "Result",
            c.result ? (isEgr && c.result === "failed" ? "Fail" : COMPONENT_RESULT_LABEL[c.result] ?? c.result) : "-",
          ]);
          if (c.result_note) rows.push(["Reason", c.result_note]);
          return (
            <div key={c.id} className="component">
              <strong>
                {c.component_type} #{c.seq}
              </strong>
              <div className="grid3" style={{ marginTop: 8 }}>
                {rows.map(([k, v]) => (
                  <Fact key={k} label={k} value={v} />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section className="section">
        <h3>Additional Authorization Requests</h3>
        {requests.length === 0 && <p className="small">No additional authorization requests.</p>}
        {requests.map((r) => {
          const item = one(r.catalog_items);
          return (
            <div key={r.id} className={`authCard ${r.status === "withdrawn" ? "rejected" : r.status}`}>
              <div className="row between" style={{ alignItems: "center" }}>
                <strong>
                  AR-{job.wo_number}-{r.seq}
                </strong>
                <span className={`badge ${r.status}`}>{AUTH_STATUS_LABEL[r.status] ?? r.status}</span>
              </div>
              <div style={{ marginTop: 6 }}>
                {r.kind === "service" ? "Service" : "Part"}: <strong>{item?.sku}</strong> - {item?.name} (Qty {Number(r.qty)})
              </div>
              <div className="small" style={{ whiteSpace: "pre-wrap" }}>
                {r.note}
              </div>
              <div className="small">Requested {date(r.requested_at)}</div>
            </div>
          );
        })}
      </section>

      <section className="section">
        <h3>Photos &amp; Attachments</h3>
        {files.length === 0 && <p className="small">No attachments the shop can see.</p>}
        <div className="attachmentGrid">
          {files.map((a) => {
            const isImage = (a.mime_type ?? "").startsWith("image/");
            return (
              <div key={a.id}>
                {a.url && isImage ? (
                  <a href={a.url} target="_blank" rel="noopener noreferrer">
                    {/* Signed storage URLs expire, so next/image caching does not fit here. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="thumb" src={a.url} alt={a.file_name} loading="lazy" />
                  </a>
                ) : null}
                <div className="small" style={{ marginTop: 6 }}>
                  {ATTACHMENT_CATEGORY_LABEL[a.category] ?? a.category}
                </div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  {a.url ? (
                    <a className="link" href={a.url} target="_blank" rel="noopener noreferrer">
                      {a.file_name}
                    </a>
                  ) : (
                    a.file_name
                  )}
                </div>
                {a.component_id && componentName.get(a.component_id) && (
                  <div className="small">For {componentName.get(a.component_id)}</div>
                )}
                {a.note && <div className="small">{a.note}</div>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="section">
        <h3>History</h3>
        {events.length === 0 ? (
          <p className="small">No history the shop can see.</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {events.map((e) => (
              <div key={e.id} className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                <span className="small nowrap" style={{ minWidth: 150 }}>
                  {dateTime(e.at)}
                </span>
                <span style={{ flex: 1 }}>
                  {e.message}
                  {e.to_status && (
                    <span className="small"> ({SHOP_STATUS_LABEL[e.to_status] ?? STATUS_LABEL[e.to_status]})</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
