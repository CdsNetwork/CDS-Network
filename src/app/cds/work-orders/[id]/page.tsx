import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { ActionForm } from "@/components/cds-wo/ActionForm";
import { FormSearchSelect } from "@/components/cds-wo/FormSearchSelect";
import styles from "@/components/cds-wo/cds-wo.module.css";
import type { SearchOption } from "@/components/SearchSelect";
import {
  CUSTOMER_APPROVAL_LABEL,
  isUuid,
  LABEL_STATUS_LABEL,
  LINES_LOCKED_STATUSES,
  one,
  PRICE_SOURCE_LABEL,
  REQUEST_TYPE_LABEL,
  REVIEW_STATUSES,
  round2,
  TAX_CLASS_LABEL,
} from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import {
  ATTACHMENT_CATEGORY_LABEL,
  CATEGORY_LABEL,
  COMPONENT_RESULT_LABEL,
  dateTime,
  DIRECTION_LABEL,
  FULFILLMENT_LABEL,
  money,
  pickupWindowLabel,
  SHIP_STATUS_LABEL,
  SHIPMENT_STATUS_LABEL,
  STATUS_LABEL,
  woLabel,
  type WoStatus,
  wrapCell,
} from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  addLine,
  addShipment,
  decideAuthorization,
  dispatchWorkOrder,
  removeLine,
  setStatus,
  updateTax,
  updateWorkOrderFields,
} from "./actions";

type MaybeOne<T> = T | T[] | null;

type WorkOrder = {
  id: string;
  wo_number: number;
  status: WoStatus;
  customer_id: string;
  location_label: string;
  site_address: string | null;
  request_type: string;
  fulfillment: string;
  affiliate_id: string | null;
  unit_number: string;
  po_number: string | null;
  requested_work: string;
  pickup_window: string | null;
  shop_ship_status: string | null;
  affiliate_invoice_ref: string | null;
  dispatched_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  delivered_at: string | null;
  created_at: string;
  customers: MaybeOne<{ name: string; code: string }>;
  affiliates: MaybeOne<{ display_name: string }>;
  customer_locations: MaybeOne<{ code: string; name: string; default_affiliate_id: string | null; dock_note: string | null }>;
};

type Internal = {
  source: string;
  review_reason: string | null;
  routing_notes: string | null;
  internal_notes: string | null;
  approved_at: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  tax_rate: number;
  tax_parts: boolean;
  tax_labor: boolean;
  tax_shipping: boolean;
  tax_jurisdiction: string | null;
  tax_source: string | null;
  ready_to_invoice_at: string | null;
  invoiced_at: string | null;
  profiles: MaybeOne<{ full_name: string }>;
};

type Financials = {
  customer_subtotal: number;
  shop_subtotal: number;
  shipping_cost: number;
  margin_before_shipping: number;
  margin: number;
  supplier_cost_tbd: boolean;
};

type Line = {
  id: string;
  qty: number;
  shop_unit_rate: number | null;
  origin: string;
  catalog_items: MaybeOne<{ sku: string; name: string }>;
  work_order_line_pricing: MaybeOne<{ customer_unit_price: number; price_source: string; tax_class: string }>;
};

type Component = {
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
  weight_removed_g: number | null;
  result: string | null;
  result_note: string | null;
};

type AuthRequest = {
  id: string;
  seq: number;
  kind: string;
  qty: number;
  note: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  customer_approval: string;
  catalog_items: MaybeOne<{ sku: string; name: string }>;
  authorization_decisions: MaybeOne<{ decision_note: string | null; customer_approved_by_name: string | null }>;
};

type Attachment = {
  id: string;
  component_id: string | null;
  category: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  note: string | null;
  shop_visible: boolean;
  uploaded_at: string;
};

type Shipment = {
  id: string;
  direction: string;
  carrier: string | null;
  service_level: string | null;
  tracking_number: string | null;
  label_status: string;
  status: string;
  eta_text: string | null;
  created_at: string;
  shipment_internal: MaybeOne<{ notes: string | null; quoted_cost: number | null; actual_cost: number | null }>;
};

type ShopRow = {
  id: string;
  display_name: string;
  kind: string;
  city: string | null;
  region: string | null;
  can_egr: boolean | null;
  can_oil_soaked: boolean | null;
};

const DEMO_RE = /\(demo\)/i;

function yesNo(v: boolean | null): string {
  return v === null ? "not set" : v ? "yes" : "no";
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Active customer locations per default shop, in pages (PostgREST returns at most 1000 rows). */
async function loadLocationCounts(supabase: Supabase): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase
      .from("customer_locations")
      .select("default_affiliate_id")
      .eq("active", true)
      .not("default_affiliate_id", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error || !data) break;
    for (const r of data as { default_affiliate_id: string }[]) {
      counts.set(r.default_affiliate_id, (counts.get(r.default_affiliate_id) ?? 0) + 1);
    }
    if (data.length < 1000) break;
  }
  return counts;
}

type WoEvent = { id: number; at: string; message: string; shop_visible: boolean; to_status: WoStatus | null };

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="small" style={{ fontWeight: 750 }}>
        {label}
      </div>
      <div style={{ marginTop: 3, whiteSpace: "pre-wrap" }}>{children || <span className="small">-</span>}</div>
    </div>
  );
}

/**
 * Who approved the order. The name is stored with the approval, so it stays when that
 * login is deleted later (approved_by then becomes null).
 */
function approvedLabel(internal: Internal | null, currentName: string | null): string {
  if (!internal?.approved_at) return "Not approved yet";
  const when = dateTime(internal.approved_at);
  const name = currentName ?? internal.approved_by_name;
  if (!name) return `Approved ${when}`;
  const removed = internal.approved_by === null ? " (login removed)" : "";
  return `${name}${removed}, ${when}`;
}

function Milestone2() {
  return <span className="small"> Milestone 2</span>;
}

function num(v: number | null, unit = ""): string {
  return v === null || v === undefined ? "-" : `${v}${unit}`;
}

export default async function WorkOrderPage({ params }: PageProps<"/cds/work-orders/[id]">) {
  await requireCds();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();

  const { data: woData } = await supabase
    .from("work_orders")
    .select(
      "*, customers(name, code), affiliates(display_name), customer_locations(code, name, default_affiliate_id, dock_note)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!woData) notFound();
  const wo = woData as unknown as WorkOrder;

  const [internalRes, finRes, linesRes, compRes, authRes, attRes, shipRes, eventRes, shopsRes, catalogRes, locationCounts] =
    await Promise.all([
      supabase
        .from("work_order_internal")
        .select(
          "source, review_reason, routing_notes, internal_notes, approved_at, approved_by, approved_by_name, tax_rate, tax_parts, tax_labor, tax_shipping, tax_jurisdiction, tax_source, ready_to_invoice_at, invoiced_at, profiles(full_name)",
        )
        .eq("work_order_id", id)
        .maybeSingle(),
      supabase
        .from("work_order_financials")
        .select("customer_subtotal, shop_subtotal, shipping_cost, margin_before_shipping, margin, supplier_cost_tbd")
        .eq("work_order_id", id)
        .maybeSingle(),
      supabase
        .from("work_order_lines")
        .select("id, qty, shop_unit_rate, origin, catalog_items(sku, name), work_order_line_pricing(customer_unit_price, price_source, tax_class)")
        .eq("work_order_id", id)
        .order("created_at"),
      supabase.from("work_order_components").select("*").eq("work_order_id", id).order("seq"),
      supabase
        .from("authorization_requests")
        .select(
          "id, seq, kind, qty, note, status, requested_at, decided_at, customer_approval, catalog_items(sku, name), authorization_decisions(decision_note, customer_approved_by_name)",
        )
        .eq("work_order_id", id)
        .order("seq"),
      supabase.from("attachments").select("*").eq("work_order_id", id).order("uploaded_at"),
      supabase
        .from("shipments")
        .select(
          "id, direction, carrier, service_level, tracking_number, label_status, status, eta_text, created_at, shipment_internal(notes, quoted_cost, actual_cost)",
        )
        .eq("work_order_id", id)
        .order("created_at"),
      supabase.from("work_order_events").select("id, at, message, shop_visible, to_status").eq("work_order_id", id).order("at"),
      supabase
        .from("affiliates")
        .select("id, display_name, kind, city, region, can_egr, can_oil_soaked")
        .eq("active", true)
        .order("display_name"),
      supabase.from("catalog_items").select("id, sku, name, category, oe_cross").eq("active", true).order("sku"),
      loadLocationCounts(supabase),
    ]);

  const internal = internalRes.data as unknown as Internal | null;
  const fin = finRes.data as Financials | null;
  const lines = (linesRes.data ?? []) as unknown as Line[];
  const components = (compRes.data ?? []) as Component[];
  const requests = (authRes.data ?? []) as unknown as AuthRequest[];
  const attachments = (attRes.data ?? []) as Attachment[];
  const shipments = (shipRes.data ?? []) as unknown as Shipment[];
  const events = (eventRes.data ?? []) as WoEvent[];
  const shops = (shopsRes.data ?? []) as ShopRow[];
  const catalog = (catalogRes.data ?? []) as { id: string; sku: string; name: string; category: string; oe_cross: string | null }[];

  // Signed links for files (bucket is private; checked as CDS above).
  const signed = new Map<string, string>();
  if (attachments.length) {
    try {
      const admin = createAdminClient();
      const { data } = await admin.storage.from("wo-files").createSignedUrls(
        attachments.map((a) => a.storage_path),
        600,
      );
      for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
    } catch {
      // Links stay hidden if storage is not reachable.
    }
  }

  const customer = one(wo.customers);
  const shop = one(wo.affiliates);
  const location = one(wo.customer_locations);
  const inReview = REVIEW_STATUSES.includes(wo.status);
  const declined = wo.status === "rejected_by_affiliate";
  const linesLocked = LINES_LOCKED_STATUSES.includes(wo.status);
  const tbd = fin?.supplier_cost_tbd ?? false;
  const approver = one(internal?.profiles ?? null);

  // Tax summary from the line snapshots and the order's tax flags.
  const rate = Number(internal?.tax_rate ?? 0);
  const taxed: Record<string, boolean> = {
    parts: internal?.tax_parts ?? false,
    labor: internal?.tax_labor ?? false,
    shipping: internal?.tax_shipping ?? false,
    exempt: false,
  };
  let subtotal = 0;
  let taxable = 0;
  let shopTotal = 0;
  for (const l of lines) {
    const p = one(l.work_order_line_pricing);
    const amount = (p?.customer_unit_price ?? 0) * l.qty;
    subtotal += amount;
    shopTotal += (l.shop_unit_rate ?? 0) * l.qty;
    if (p && taxed[p.tax_class]) taxable += amount;
  }
  subtotal = round2(subtotal);
  taxable = round2(taxable);
  const salesTax = round2((taxable * rate) / 100);
  const compName = new Map(components.map((c) => [c.id, `${c.component_type} #${c.seq}`]));
  const defaultShop = location?.default_affiliate_id ?? wo.affiliate_id ?? "";

  // Dispatch picker: the location's default shop first, then the rest by name.
  const locationDefault = location?.default_affiliate_id ?? null;
  const shopOptions: SearchOption[] = [...shops]
    .sort((a, b) => Number(b.id === locationDefault) - Number(a.id === locationDefault))
    .map((s) => {
      const marks = [
        s.id === locationDefault ? "(location default)" : "",
        declined && s.id === wo.affiliate_id ? "(declined)" : "",
        // Demo shops carry "(demo)" in their name on staging; mark any other "demo" shop too.
        /\bdemo\b/i.test(s.display_name) && !DEMO_RE.test(s.display_name) ? "(demo)" : "",
        s.kind === "parts_supplier" ? "(parts supplier)" : "",
      ].filter(Boolean);
      const place = [s.city, s.region].filter(Boolean).join(", ") || "No city";
      const n = locationCounts.get(s.id) ?? 0;
      return {
        value: s.id,
        label: [s.display_name, ...marks].join(" "),
        hint: `${place} - EGR ${yesNo(s.can_egr)} - oil soaked ${yesNo(s.can_oil_soaked)} - ${n} ${n === 1 ? "location" : "locations"}`,
        keywords: s.kind === "parts_supplier" ? "supplier parts" : undefined,
      };
    });
  const catalogOptions: SearchOption[] = catalog.map((c) => ({
    value: c.id,
    label: `${c.sku} - ${c.name}`,
    hint: CATEGORY_LABEL[c.category] ?? c.category,
    keywords: c.oe_cross ?? undefined,
  }));

  // Lines priced below what the shop is paid lose money on every unit.
  const isNegative = (l: Line) => {
    const p = one(l.work_order_line_pricing);
    return l.shop_unit_rate !== null && p !== null && Number(p.customer_unit_price) < Number(l.shop_unit_rate);
  };
  const negativeLines = lines.filter(isNegative);

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>{woLabel(wo.wo_number)}</h1>
          <p>
            {customer?.name ?? "Unknown customer"} • {wo.location_label} • Unit {wo.unit_number}
          </p>
        </div>
        <div className="row">
          <Link className="btn btn-secondary" href="/cds">
            Back
          </Link>
          {inReview && <span className="status pending_review">NOT SENT TO AFFILIATE</span>}
        </div>
      </div>

      <div className="grid4" style={{ margin: "22px 0" }}>
        <div className="card">
          <div className="small">STATUS</div>
          <div style={{ marginTop: 10 }}>
            <StatusBadge status={wo.status} />
          </div>
        </div>
        <div className="card">
          <div className="small">AFFILIATE PAYABLE</div>
          <div className="bigAmount">{tbd ? "TBD" : money(fin?.shop_subtotal ?? shopTotal)}</div>
        </div>
        <div className="card">
          <div className="small">CUSTOMER SUBTOTAL (BEFORE TAX)</div>
          <div className="bigAmount">{money(fin?.customer_subtotal ?? subtotal)}</div>
        </div>
        <div className="card">
          <div className="small">GROSS MARGIN</div>
          <div className="bigAmount">{tbd ? "TBD" : money(fin?.margin)}</div>
          {fin && Number(fin.shipping_cost) > 0 && (
            <div className="small">After {money(fin.shipping_cost)} shipping cost</div>
          )}
        </div>
      </div>

      <div className="split">
        {/* ---------------------------------------------------------- left column */}
        <div>
          <section className="section" style={{ marginTop: 0 }}>
            <h3>Work order</h3>
            <div className="grid2">
              <Fact label="PO">{wo.po_number ?? <span className="small">Missing</span>}</Fact>
              <Fact label="Affiliate">{shop?.display_name ?? "Not assigned"}</Fact>
              <Fact label="Approved By">
                {approvedLabel(internal, approver?.full_name ?? null)}
              </Fact>
              <Fact label="Affiliate Invoice / Reference #">{wo.affiliate_invoice_ref}</Fact>
              <Fact label="Pickup / ship-to address">{wo.site_address}</Fact>
              <Fact label="Request Type">{REQUEST_TYPE_LABEL[wo.request_type] ?? wo.request_type}</Fact>
              <Fact label="Fulfillment">{FULFILLMENT_LABEL[wo.fulfillment] ?? wo.fulfillment}</Fact>
              {wo.fulfillment === "pickup" ? (
                <Fact label="Pickup window">{pickupWindowLabel(wo.pickup_window)}</Fact>
              ) : (
                <Fact label="Shop shipping status">{wo.shop_ship_status ? SHIP_STATUS_LABEL[wo.shop_ship_status] : null}</Fact>
              )}
              <Fact label="Requested work">{wo.requested_work}</Fact>
              <Fact label="Location">
                {wo.location_label}
                {location?.dock_note ? `\nDock: ${location.dock_note}` : ""}
              </Fact>
              <Fact label="Routing notes">{internal?.routing_notes}</Fact>
              <Fact label="Internal notes">{internal?.internal_notes}</Fact>
              <Fact label="Created">
                {dateTime(wo.created_at)} ({internal?.source === "manual" ? "manual" : internal?.source})
              </Fact>
              <Fact label="Dispatched / completed">
                {[wo.dispatched_at && `Dispatched ${dateTime(wo.dispatched_at)}`, wo.completed_at && `Completed ${dateTime(wo.completed_at)}`]
                  .filter(Boolean)
                  .join("\n")}
              </Fact>
            </div>
          </section>

          <section className="section">
            <h3>Logistics</h3>
            {shipments.length === 0 &&
              (wo.fulfillment === "pickup" ? (
                <div className="notice">
                  <b>Affiliate Pickup / Local Delivery.</b> The shop picks up and returns the part; no shipment legs needed.
                </div>
              ) : (
                <p className="small">No shipment legs yet. Add one below when a tracking number is known.</p>
              ))}
            <div style={{ display: "grid", gap: 10 }}>
              {shipments.map((s) => {
                const si = one(s.shipment_internal);
                return (
                  <div key={s.id} className="summarybox">
                    <div className="row between">
                      <b>{DIRECTION_LABEL[s.direction] ?? s.direction}</b>
                      <span className="tag">{SHIPMENT_STATUS_LABEL[s.status] ?? s.status}</span>
                    </div>
                    <div className="small">
                      {s.carrier ?? "Carrier not set"}
                      {s.service_level ? ` • ${s.service_level}` : ""} • Label: {LABEL_STATUS_LABEL[s.label_status] ?? s.label_status}
                      {s.eta_text ? ` • ETA ${s.eta_text}` : ""}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 850, color: "var(--blue)", margin: "6px 0" }}>
                      Tracking # {s.tracking_number ?? "Pending"}
                    </div>
                    <div className="small">
                      Quoted {money(si?.quoted_cost)} • Actual {money(si?.actual_cost)}
                      {si?.notes ? ` • ${si.notes}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
            <details style={{ marginTop: 14 }}>
              <summary className="link">Add shipment</summary>
              <ActionForm action={addShipment.bind(null, wo.id)} submitLabel="Save Shipment" resetOnSuccess className="summarybox">
                <div className="grid3">
                  <div className="field">
                    <label htmlFor="ship-direction">Direction</label>
                    <select id="ship-direction" name="direction" defaultValue={wo.fulfillment === "supplier_direct" ? "supplier_to_customer" : "customer_to_affiliate"}>
                      {Object.entries(DIRECTION_LABEL).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="ship-carrier">Carrier</label>
                    <select id="ship-carrier" name="carrier" defaultValue="UPS">
                      <option value="UPS">UPS</option>
                      <option value="FedEx">FedEx</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="ship-service">Service level</label>
                    <input id="ship-service" name="service_level" className="input" placeholder="Ground" maxLength={100} />
                  </div>
                  <div className="field">
                    <label htmlFor="ship-tracking">Tracking #</label>
                    <input id="ship-tracking" name="tracking_number" className="input" maxLength={100} />
                  </div>
                  <div className="field">
                    <label htmlFor="ship-status">Status</label>
                    <select id="ship-status" name="status" defaultValue="label_created">
                      {Object.entries(SHIPMENT_STATUS_LABEL).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="ship-quoted">Quoted cost</label>
                    <input id="ship-quoted" name="quoted_cost" className="input" type="number" min="0" step="0.01" />
                  </div>
                  <div className="field">
                    <label htmlFor="ship-actual">Actual cost</label>
                    <input id="ship-actual" name="actual_cost" className="input" type="number" min="0" step="0.01" />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="ship-notes">Notes (CDS only)</label>
                  <input id="ship-notes" name="notes" className="input" maxLength={2000} />
                </div>
              </ActionForm>
            </details>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn-secondary btn-small" type="button" disabled>
                Create Label
              </button>
              <button className="btn btn-secondary btn-small" type="button" disabled>
                Compare Rates
              </button>
              <Milestone2 />
            </div>
          </section>

          {wo.request_type !== "parts_only" && (
            <section className="section">
              <h3>Components received</h3>
              {components.length === 0 ? (
                <p className="small">The shop has not entered any components yet.</p>
              ) : (
                components.map((c) => (
                  <div key={c.id} className="component">
                    <div className="row between">
                      <b>
                        {c.component_type} #{c.seq}
                      </b>
                      {c.result ? (
                        <span className={`tag${c.result === "failed" || c.result === "condemned" ? "" : " green"}`}>
                          {COMPONENT_RESULT_LABEL[c.result] ?? c.result}
                        </span>
                      ) : (
                        <span className="tag">No result yet</span>
                      )}
                    </div>
                    <div className="grid3" style={{ marginTop: 10 }}>
                      <Fact label="Manufacturer">{c.manufacturer}</Fact>
                      <Fact label="Part #">{c.part_number}</Fact>
                      <Fact label="Serial #">{c.serial_number}</Fact>
                      {c.component_type !== "EGR" && (
                        <>
                          <Fact label="DP Before">{num(c.dp_before)}</Fact>
                          <Fact label="DP After">{num(c.dp_after)}</Fact>
                          <Fact label="Weight Before">{num(c.weight_before_g, " g")}</Fact>
                          <Fact label="Weight After">{num(c.weight_after_g, " g")}</Fact>
                          <Fact label="Weight Removed">{num(c.weight_removed_g, " g")}</Fact>
                        </>
                      )}
                      <Fact label="Result note">{c.result_note}</Fact>
                    </div>
                  </div>
                ))
              )}
            </section>
          )}

          <section className="section">
            <h3>Services &amp; parts</h3>
            {negativeLines.length > 0 && (
              <div className="notice danger" role="status">
                <b>Negative margin:</b> {negativeLines.length === 1 ? "1 line is" : `${negativeLines.length} lines are`} priced
                below the shop rate ({negativeLines.map((l) => one(l.catalog_items)?.sku ?? "item").join(", ")}). Check the
                customer price before dispatch and invoicing.
              </div>
            )}
            <div className="tablewrap">
              <table style={{ minWidth: 820 }}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Shop Rate</th>
                    <th className="num">Customer Price</th>
                    <th>Price Source</th>
                    <th>Tax Class</th>
                    <th className="num">Line Margin</th>
                    {!linesLocked && <th />}
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={linesLocked ? 7 : 8} className="small" style={{ textAlign: "center" }}>
                        No services or parts yet. Add at least one before dispatch.
                      </td>
                    </tr>
                  )}
                  {lines.map((l) => {
                    const item = one(l.catalog_items);
                    const p = one(l.work_order_line_pricing);
                    const shopAmt = (l.shop_unit_rate ?? 0) * l.qty;
                    const custAmt = (p?.customer_unit_price ?? 0) * l.qty;
                    const negative = isNegative(l);
                    return (
                      <tr key={l.id} className={negative ? styles.negRow : undefined}>
                        <td>
                          <b>{item?.sku}</b>
                          <div className="small">{item?.name}</div>
                          {negative && (
                            <div>
                              <span className={styles.negTag} title="The customer price is lower than the shop rate">
                                Below shop rate
                              </span>
                            </div>
                          )}
                          {l.origin !== "cds_order" && (
                            <span className="tag blue">{l.origin === "shop_added" ? "Added by shop" : "Extra work request"}</span>
                          )}
                        </td>
                        <td className="num">{l.qty}</td>
                        <td className="num">
                          <span className="money">{l.shop_unit_rate === null ? "TBD" : money(shopAmt)}</span>
                          <div className="small">{l.shop_unit_rate === null ? "" : `${money(l.shop_unit_rate)} each`}</div>
                        </td>
                        <td className="num">
                          <span className="money">{money(custAmt)}</span>
                          <div className="small">{money(p?.customer_unit_price)} each</div>
                        </td>
                        <td>{p ? PRICE_SOURCE_LABEL[p.price_source] ?? p.price_source : "-"}</td>
                        <td>
                          {p && <span className="tag">{TAX_CLASS_LABEL[p.tax_class] ?? p.tax_class}</span>}
                          <div className="small">{p && taxed[p.tax_class] ? "Taxable" : "Non-taxable"}</div>
                        </td>
                        <td className="num money">{l.shop_unit_rate === null ? "TBD" : money(round2(custAmt - shopAmt))}</td>
                        {!linesLocked && (
                          <td>
                            <ActionForm
                              action={removeLine.bind(null, wo.id, l.id)}
                              submitLabel="Remove"
                              pendingLabel="..."
                              buttonClass="remove"
                              confirmText="Remove this line from the work order?"
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {lines.length > 0 && (
                    <tr>
                      <td colSpan={2}>
                        <b>Totals</b>
                      </td>
                      <td className="num money">{tbd ? "TBD" : money(shopTotal)}</td>
                      <td className="num money">{money(subtotal)}</td>
                      <td colSpan={2} />
                      <td className="num money">{tbd ? "TBD" : money(round2(subtotal - shopTotal))}</td>
                      {!linesLocked && <td />}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {!linesLocked ? (
              <ActionForm action={addLine.bind(null, wo.id)} submitLabel="+ Add Item" inline resetOnSuccess buttonClass="btn btn-secondary" className="summarybox" >
                <div style={{ flex: "1 1 260px" }}>
                  <label className="small" htmlFor="line-item">
                    Catalog item
                  </label>
                  <FormSearchSelect
                    id="line-item"
                    name="catalog_item_id"
                    options={catalogOptions}
                    required
                    placeholder="Type SKU, name or OE number..."
                    limit={150}
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className="small" htmlFor="line-qty">
                    Qty
                  </label>
                  <input id="line-qty" name="qty" className="input" type="number" min="0.01" step="any" defaultValue="1" required />
                </div>
              </ActionForm>
            ) : (
              <p className="small">Lines are fixed once the work is completed.</p>
            )}
          </section>

          <section className="section">
            <h3>Extra work requests</h3>
            {requests.length === 0 ? (
              <p className="small">The shop has not asked for extra work on this order.</p>
            ) : (
              requests.map((r) => {
                const item = one(r.catalog_items);
                const d = one(r.authorization_decisions);
                return (
                  <div key={r.id} className={`authCard ${r.status}`}>
                    <div className="row between">
                      <b>
                        Request #{r.seq}: {item?.sku} {item?.name} × {r.qty}
                      </b>
                      <span className={`badge ${r.status}`}>{r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span>
                    </div>
                    <p style={{ margin: "6px 0" }}>{r.note}</p>
                    <div className="small">
                      Requested {dateTime(r.requested_at)} • {CUSTOMER_APPROVAL_LABEL[r.customer_approval] ?? r.customer_approval}
                      {d?.customer_approved_by_name ? ` by ${d.customer_approved_by_name}` : ""}
                      {r.decided_at ? ` • Decided ${dateTime(r.decided_at)}` : ""}
                    </div>
                    {d?.decision_note && <div className="small">CDS note: {d.decision_note}</div>}
                    {r.status === "pending" && (
                      <div className="grid2" style={{ marginTop: 10, gap: 12 }}>
                        <ActionForm action={decideAuthorization.bind(null, wo.id, r.id, true)} submitLabel="Approve" pendingLabel="Approving...">
                          <div className="field">
                            <label htmlFor={`appr-by-${r.id}`}>
                              Customer approved by <span className="req">*</span>
                            </label>
                            <input id={`appr-by-${r.id}`} name="customer_approved_by" className="input" required maxLength={200} placeholder="Name at the customer" />
                          </div>
                          <div className="field">
                            <label htmlFor={`appr-note-${r.id}`}>Note (CDS only)</label>
                            <input id={`appr-note-${r.id}`} name="decision_note" className="input" maxLength={2000} />
                          </div>
                        </ActionForm>
                        <ActionForm
                          action={decideAuthorization.bind(null, wo.id, r.id, false)}
                          submitLabel="Decline"
                          pendingLabel="Declining..."
                          buttonClass="btn btn-danger"
                        >
                          <div className="field">
                            <label htmlFor={`decl-note-${r.id}`}>Reason (optional, CDS only)</label>
                            <input id={`decl-note-${r.id}`} name="decision_note" className="input" maxLength={2000} />
                          </div>
                        </ActionForm>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </section>

          <section className="section">
            <h3>Photos &amp; attachments</h3>
            {attachments.length === 0 ? (
              <p className="small">No files on this work order.</p>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Category</th>
                      <th>Component</th>
                      <th>Uploaded</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {attachments.map((a) => {
                      const url = signed.get(a.storage_path);
                      return (
                        <tr key={a.id}>
                          <td className={wrapCell(a.file_name, a.note)}>
                            <b>{a.file_name}</b>
                            {a.note && <div className="small">{a.note}</div>}
                          </td>
                          <td>{ATTACHMENT_CATEGORY_LABEL[a.category] ?? a.category}</td>
                          <td>{a.component_id ? compName.get(a.component_id) ?? "-" : "-"}</td>
                          <td>
                            <span className="nowrap">{dateTime(a.uploaded_at)}</span>
                            <div>{a.shop_visible ? <span className="tag blue">shop sees this</span> : <span className="tag">CDS only</span>}</div>
                          </td>
                          <td>
                            {url ? (
                              <a className="link" href={url} target="_blank" rel="noreferrer">
                                Open
                              </a>
                            ) : (
                              <span className="small">Unavailable</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="small">Links expire after 10 minutes. Reload the page for fresh links.</p>
          </section>

          <section className="section">
            <h3>History</h3>
            {events.length === 0 ? (
              <p className="small">No history yet.</p>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {events.map((e) => (
                  <div key={e.id} className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                    <span className="small nowrap" style={{ minWidth: 150 }}>
                      {dateTime(e.at)}
                    </span>
                    <span style={{ flex: 1 }}>
                      {e.message}
                      {e.to_status && <span className="small"> ({STATUS_LABEL[e.to_status]})</span>}
                    </span>
                    {e.shop_visible && <span className="tag blue">shop sees this</span>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* ---------------------------------------------------------- right column */}
        <div>
          {inReview && (
            <section className={`section panel-review`} style={{ marginTop: 0, ...(declined ? { borderColor: "#f0b8b2", background: "#fff5f4" } : {}) }}>
              <h3>{declined ? "Declined by shop" : "Review & Dispatch"}</h3>
              <p className="small" style={{ color: declined ? "#a1261d" : "#7a5200" }}>
                <b>{declined ? "Decline reason:" : "Why review is required:"}</b>{" "}
                {internal?.review_reason ?? (declined ? "No reason recorded." : "Every new order is reviewed by CDS before dispatch.")}
              </p>
              <p className="small">The affiliate cannot see this work order until CDS resolves the exception and dispatches it.</p>
              {lines.length === 0 && <div className="notice warning">Add at least one service or part before dispatch.</div>}
              <ActionForm action={dispatchWorkOrder.bind(null, wo.id)} submitLabel="Approve & Dispatch to Affiliate" pendingLabel="Dispatching...">
                <div className="field">
                  <label htmlFor="dispatch-shop">Shop</label>
                  <FormSearchSelect
                    id="dispatch-shop"
                    name="affiliate_id"
                    options={shopOptions}
                    defaultValue={defaultShop}
                    required
                    placeholder="Type shop name, city or state..."
                    limit={150}
                  />
                </div>
              </ActionForm>
            </section>
          )}

          {inReview && (
            <section className="section">
              <h3>Edit order</h3>
              <ActionForm action={updateWorkOrderFields.bind(null, wo.id)} submitLabel="Save Changes">
                <div className="grid2" style={{ gap: 10 }}>
                  <div className="field">
                    <label htmlFor="edit-unit">
                      Unit # <span className="req">*</span>
                    </label>
                    <input id="edit-unit" name="unit_number" className="input" defaultValue={wo.unit_number} required maxLength={100} />
                  </div>
                  <div className="field">
                    <label htmlFor="edit-po">PO #</label>
                    <input id="edit-po" name="po_number" className="input" defaultValue={wo.po_number ?? ""} maxLength={100} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="edit-loc">
                    Location label <span className="req">*</span>
                  </label>
                  <input id="edit-loc" name="location_label" className="input" defaultValue={wo.location_label} required maxLength={200} />
                </div>
                <div className="field">
                  <label htmlFor="edit-addr">Site / ship-to address</label>
                  <input id="edit-addr" name="site_address" className="input" defaultValue={wo.site_address ?? ""} maxLength={500} />
                </div>
                <div className="field">
                  <label htmlFor="edit-type">Request Type</label>
                  <select id="edit-type" name="request_type" defaultValue={wo.request_type}>
                    <option value="service">Service / Cleaning</option>
                    <option value="parts_only">Parts Only</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="edit-ful">Fulfillment</label>
                  <select id="edit-ful" name="fulfillment" defaultValue={wo.fulfillment}>
                    {Object.entries(FULFILLMENT_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="edit-work">
                    Requested work <span className="req">*</span>
                  </label>
                  <textarea id="edit-work" name="requested_work" rows={3} defaultValue={wo.requested_work} required maxLength={2000} />
                </div>
              </ActionForm>
            </section>
          )}

          {wo.status === "ready_to_invoice" && (
            <section className="section panel-invoice">
              <h3>Ready to Invoice</h3>
              <p className="small">
                Work is complete. One action will create the customer invoice in QuickBooks and email it to the customer.
              </p>
              <button className="btn btn-blue" type="button" disabled>
                Create in QuickBooks &amp; Email Customer
              </button>
              <Milestone2 />
            </section>
          )}

          <section className="section">
            <h3>Status</h3>
            <div className="row" style={{ marginBottom: 10 }}>
              <StatusBadge status={wo.status} />
              {wo.delivered_at && <span className="small">Delivered {dateTime(wo.delivered_at)}</span>}
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {wo.status === "completed" && (
                <ActionForm action={setStatus.bind(null, wo.id, "delivered")} submitLabel="Mark Delivered" buttonClass="btn btn-secondary" />
              )}
              {(wo.status === "completed" || wo.status === "delivered") && (
                <ActionForm action={setStatus.bind(null, wo.id, "ready_to_invoice")} submitLabel="Ready to Invoice" />
              )}
              {wo.status === "awaiting_acceptance" && (
                <ActionForm
                  action={setStatus.bind(null, wo.id, "pending_review")}
                  submitLabel="Send back to review"
                  buttonClass="btn btn-secondary"
                  confirmText="Take this order back from the shop and return it to review?"
                />
              )}
              {wo.status !== "invoiced" && wo.status !== "cancelled" && (
                <details>
                  <summary className="small link">Cancel work order</summary>
                  <ActionForm
                    action={setStatus.bind(null, wo.id, "cancelled")}
                    submitLabel="Cancel Work Order"
                    pendingLabel="Cancelling..."
                    buttonClass="btn btn-danger"
                    confirmText="Cancel this work order? The shop will see that it was cancelled."
                  >
                    <div className="field" style={{ marginTop: 8 }}>
                      <label htmlFor="cancel-note">Reason (optional)</label>
                      <input id="cancel-note" name="note" className="input" maxLength={2000} />
                    </div>
                  </ActionForm>
                </details>
              )}
              {["accepted", "picked_up", "in_process"].includes(wo.status) && (
                <p className="small">The shop moves this order forward. CDS can act again once the shop completes it.</p>
              )}
            </div>
          </section>

          <section className="section">
            <h3>Customer invoice &amp; tax</h3>
            <div className="summarybox">
              <div className="summaryrow">
                <span>Subtotal</span>
                <b className="money">{money(subtotal)}</b>
              </div>
              <div className="summaryrow">
                <span>Taxable amount</span>
                <b className="money">{money(taxable)}</b>
              </div>
              <div className="summaryrow">
                <span>Sales tax ({rate}%)</span>
                <b className="money">{money(salesTax)}</b>
              </div>
              <div className="summaryrow">
                <span>Customer invoice total</span>
                <b className="money">{money(round2(subtotal + salesTax))}</b>
              </div>
              <div className="summaryrow">
                <span>Affiliate payable</span>
                <b className="money">{tbd ? "TBD" : money(fin?.shop_subtotal ?? shopTotal)}</b>
              </div>
              <div className="summaryrow">
                <span>Gross margin (before tax)</span>
                <b className="money">{tbd ? "TBD" : money(fin?.margin)}</b>
              </div>
            </div>
            {internal && (
              <ActionForm action={updateTax.bind(null, wo.id)} submitLabel="Save Tax Settings" buttonClass="btn btn-secondary" disabled={wo.status === "invoiced"}>
                <div className="field" style={{ marginTop: 12 }}>
                  <label htmlFor="tax-rate">Sales tax rate (%)</label>
                  <input id="tax-rate" name="tax_rate" className="input" type="number" min="0" max="99.999" step="0.001" defaultValue={rate} />
                  <div className="small" style={{ marginTop: 5 }}>
                    {internal.tax_jurisdiction ? `Jurisdiction: ${internal.tax_jurisdiction}` : "No jurisdiction recorded."}
                    {internal.tax_source ? ` • Source: ${internal.tax_source.replace(/_/g, " ")}` : ""}
                  </div>
                </div>
                <div className="field" style={{ display: "grid", gap: 6 }}>
                  <label className="row" style={{ gap: 8, fontWeight: 600 }}>
                    <input type="checkbox" name="tax_parts" defaultChecked={internal.tax_parts} style={{ width: "auto" }} /> Tax parts
                  </label>
                  <label className="row" style={{ gap: 8, fontWeight: 600 }}>
                    <input type="checkbox" name="tax_labor" defaultChecked={internal.tax_labor} style={{ width: "auto" }} /> Tax labor / services
                  </label>
                  <label className="row" style={{ gap: 8, fontWeight: 600 }}>
                    <input type="checkbox" name="tax_shipping" defaultChecked={internal.tax_shipping} style={{ width: "auto" }} /> Tax shipping
                  </label>
                </div>
              </ActionForm>
            )}
            <p className="small">
              Tax is set per work order so customer locations can follow different rules. Shipping is taxed separately from
              labor and services.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
