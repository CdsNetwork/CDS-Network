import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { ActionForm } from "@/components/cds-wo/ActionForm";
import { FormSearchSelect } from "@/components/cds-wo/FormSearchSelect";
import type { LocationOption } from "@/components/cds-wo/NewWorkOrderForm";
import { OrderLocationFields } from "@/components/cds-wo/OrderLocationFields";
import { loadPickerLocations } from "@/app/cds/work-orders/new/locations";
import styles from "@/components/cds-wo/cds-wo.module.css";
import type { SearchOption } from "@/components/SearchSelect";
import {
  CUSTOMER_APPROVAL_LABEL,
  dispatchShopDefault,
  isUuid,
  LABEL_STATUS_LABEL,
  LINES_LOCKED_STATUSES,
  one,
  PRICE_SOURCE_LABEL,
  REMOVABLE_LABEL_STATUSES,
  REQUEST_TYPE_LABEL,
  REVIEW_STATUSES,
  round2,
  TAX_CLASS_LABEL,
} from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { orderTaxExempt, TAX_FROZEN_STATUSES, taxLabel, taxSummary, type TaxFlags } from "@/lib/tax";
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
  shipmentEta,
  STATUS_LABEL,
  woLabel,
  type WoStatus,
  wrapCell,
} from "@/lib/format";
import { htmlToText } from "@/lib/intake/email";
import { internalNotesHistory, NOTE_MAX_LENGTH, ORDER_CREATED_NOTE_ID, type NoteView } from "@/lib/notes";
import { NotesList } from "@/components/WorkOrderNotes";
import { AttachmentForm } from "@/components/shop/AttachmentForm";
import { cdsCanDelete, uploaderLabel } from "@/lib/attachments";
import { loadInvoice, type InvoiceState } from "@/lib/qbo/invoice-input";
import { qboStatus, type QboStatus } from "@/lib/qbo/status";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { LabelPanel, type LabelView } from "@/components/shipping/LabelPanel";
import { activeLabels, defaultPackage, shipStationConfigured } from "@/lib/shipstation/views";
import { labelShop, labelShopMismatch, missingLegEnds, shopEnd } from "@/lib/shipstation/ends";
import { packageForShipment } from "@/lib/shipstation/package";
import { NEW_SHIPMENT_STATUS } from "@/app/cds/shipping/options";
import {
  addLine,
  addPassThroughLine,
  addShipment,
  createQuickBooksInvoice,
  addInternalNote,
  addNote,
  decideAuthorization,
  deleteCdsAttachment,
  deleteInternalNote,
  deleteNote,
  dispatchWorkOrder,
  prepareCdsUpload,
  registerCdsUpload,
  removeLine,
  removePassThroughLine,
  removeShipment,
  setAttachmentShopVisible,
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
  location_id: string | null;
  location_label: string;
  site_address: string | null;
  request_type: string;
  fulfillment: string;
  affiliate_id: string | null;
  unit_number: string | null;
  po_number: string | null;
  requested_work: string;
  vin: string | null;
  mileage: number | null;
  requested_date: string | null;
  return_to_location: boolean;
  pickup_window: string | null;
  shop_ship_status: string | null;
  affiliate_invoice_ref: string | null;
  dispatched_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  delivered_at: string | null;
  created_at: string;
  customers: MaybeOne<{ name: string; code: string }>;
  affiliates: MaybeOne<{ display_name: string; is_in_house: boolean }>;
  customer_locations: MaybeOne<{ code: string; name: string; default_affiliate_id: string | null; dock_note: string | null }>;
};

type Internal = {
  source: string;
  review_reason: string | null;
  routing_notes: string | null;
  internal_notes: string | null;
  order_type: string | null;
  customer_region: string | null;
  customer_contact_name: string | null;
  customer_contact_email: string | null;
  customer_contact_phone: string | null;
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
  description: string | null;
  catalog_items: MaybeOne<{ sku: string; name: string; price_per_line: boolean }>;
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
  profiles: MaybeOne<{ full_name: string | null; kind: string | null }>;
  affiliates: MaybeOne<{ display_name: string }>;
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
  delivered_at: string | null;
  created_at: string;
  weight_lb: number | string | null;
  length_in: number | string | null;
  width_in: number | string | null;
  height_in: number | string | null;
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
  is_in_house: boolean;
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
type InboundEmail = {
  id: string;
  from_header: string | null;
  from_address: string | null;
  to_addresses: string[] | null;
  subject: string | null;
  received_at: string;
  body_text: string | null;
  body_html: string | null;
  attachments: unknown;
};

const EMAIL_COLUMNS = "id, from_header, from_address, to_addresses, subject, received_at, body_text, body_html, attachments";

/** File names from the stored attachments list ({ filename } objects). */
function attachmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((a: { filename?: unknown } | null) => (typeof a?.filename === "string" ? a.filename.trim() : ""))
    .filter(Boolean);
}

/**
 * The email an order was made from, CDS only (inbound_emails has no shop policy). Shown as
 * plain text: the HTML part is converted to text and never rendered.
 */
function OriginalEmail({ email }: { email: InboundEmail }) {
  const body = email.body_text?.trim() ? email.body_text.replace(/\r\n?/g, "\n") : htmlToText(email.body_html ?? "");
  const files = attachmentNames(email.attachments);
  return (
    <details className="summarybox" style={{ gridColumn: "1 / -1" }}>
      <summary className="link">
        Original email: {email.subject || "(no subject)"} <span className="small">{dateTime(email.received_at)}</span>
      </summary>
      <div className="grid2" style={{ marginTop: 10, gap: 12 }}>
        <Fact label="From">{email.from_header || email.from_address}</Fact>
        <Fact label="To">{(email.to_addresses ?? []).join(", ")}</Fact>
        <Fact label="Received">{dateTime(email.received_at)}</Fact>
        <Fact label="Subject">{email.subject}</Fact>
      </div>
      <pre
        className="small"
        style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 400, overflowY: "auto", margin: "10px 0 0", fontFamily: "inherit", color: "inherit" }}
      >
        {body || "No text in this email."}
      </pre>
      {files.length > 0 && <div className="small" style={{ marginTop: 8 }}>Attachments: {files.join(", ")}</div>}
    </details>
  );
}

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

/** Customer invoice in QuickBooks: create it when Ready to Invoice, show it once invoiced. */
function InvoicePanel({
  woId,
  status,
  qbo,
  invoice,
  loadError,
}: {
  woId: string;
  status: WoStatus;
  qbo: QboStatus | null;
  invoice: InvoiceState | null;
  loadError: boolean;
}) {
  const emailButton = (
    <div className="row" style={{ marginTop: 10 }}>
      {/* QuickBooks can send the invoice email (Invoice send); not built yet. */}
      <button className="btn btn-secondary btn-small" type="button" disabled>
        Email customer
      </button>
      <Milestone2 />
    </div>
  );

  if (status === "invoiced" || invoice?.qbInvoiceId) {
    return (
      <section className="section panel-invoice">
        <h3>Invoiced</h3>
        {invoice?.qbInvoiceId ? (
          <p>
            QuickBooks invoice <b>{invoice.qbInvoiceNumber ?? `id ${invoice.qbInvoiceId}`}</b>
            {invoice.invoicedAt ? <span className="small"> created {dateTime(invoice.invoicedAt)}</span> : null}
          </p>
        ) : (
          <p className="small">No QuickBooks invoice is recorded for this order.</p>
        )}
        {emailButton}
      </section>
    );
  }

  const pending = invoice?.pendingQb ?? null;
  if (pending) {
    const name = pending.number ?? `id ${pending.id}`;
    return (
      <section className="section panel-invoice">
        <h3>Ready to Invoice</h3>
        <div className="notice warning" role="status">
          QuickBooks invoice <b>{name}</b> was created in QuickBooks {dateTime(pending.at)}, but the work order was not marked
          Invoiced. Record it below; no second invoice is created.
        </div>
        <ActionForm
          action={createQuickBooksInvoice.bind(null, woId)}
          submitLabel={`Record QuickBooks invoice ${name}`}
          pendingLabel="Recording invoice..."
          buttonClass="btn btn-blue"
          disabled={loadError}
        />
        {emailButton}
      </section>
    );
  }

  const problems = invoice && !invoice.result.ok ? invoice.result.problems : [];
  const warnings = invoice?.result.warnings ?? [];
  return (
    <section className="section panel-invoice">
      <h3>Ready to Invoice</h3>
      {loadError && <div className="notice danger">The invoice details could not be loaded. Reload the page.</div>}
      {qbo && !qbo.connected ? (
        <div className="notice warning">
          QuickBooks is not connected.{" "}
          <Link className="link" href="/cds/admin?tab=settings">
            Connect it in Admin &gt; Settings
          </Link>{" "}
          to create the invoice.
        </div>
      ) : (
        <>
          <p className="small">
            Work is complete. This creates the customer invoice in QuickBooks
            {qbo?.companyName ? ` (${qbo.companyName})` : ""}; QuickBooks calculates the sales tax from the ship-to address.
          </p>
          {problems.length > 0 && (
            <div className="notice warning" role="status">
              <b>Fix these before invoicing:</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="notice warning" role="status">
              <b>The invoice can be created, but note:</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {qbo?.astEnabled === false && (
            <div className="notice warning">Automated Sales Tax is off in QuickBooks: the invoice will have no sales tax.</div>
          )}
          <ActionForm
            action={createQuickBooksInvoice.bind(null, woId)}
            submitLabel="Create QuickBooks invoice"
            pendingLabel="Creating invoice..."
            buttonClass="btn btn-blue"
            disabled={problems.length > 0 || loadError}
            confirmText="Create the customer invoice in QuickBooks and mark this work order Invoiced?"
          />
        </>
      )}
      {emailButton}
    </section>
  );
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
      "*, customers(name, code), affiliates(display_name, is_in_house), customer_locations(code, name, default_affiliate_id, dock_note)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!woData) notFound();
  const wo = woData as unknown as WorkOrder;

  const [internalRes, finRes, linesRes, compRes, authRes, attRes, shipRes, eventRes, shopsRes, catalogRes, locationCounts, billingRes, emailsRes, notesRes, internalNotesRes] =
    await Promise.all([
      supabase
        .from("work_order_internal")
        .select(
          "source, review_reason, routing_notes, internal_notes, order_type, customer_region, customer_contact_name, customer_contact_email, customer_contact_phone, approved_at, approved_by, approved_by_name, tax_rate, tax_parts, tax_labor, tax_shipping, tax_jurisdiction, tax_source, ready_to_invoice_at, invoiced_at, profiles(full_name)",
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
        .select(
          "id, qty, shop_unit_rate, origin, description, catalog_items(sku, name, price_per_line), work_order_line_pricing(customer_unit_price, price_source, tax_class)",
        )
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
      supabase
        .from("attachments")
        .select("*, profiles(full_name, kind), affiliates(display_name)")
        .eq("work_order_id", id)
        .order("uploaded_at"),
      supabase
        .from("shipments")
        .select(
          "id, direction, carrier, service_level, tracking_number, label_status, status, eta_text, delivered_at, created_at, weight_lb, length_in, width_in, height_in, shipment_internal(notes, quoted_cost, actual_cost)",
        )
        .eq("work_order_id", id)
        .order("created_at"),
      supabase.from("work_order_events").select("id, at, message, shop_visible, to_status").eq("work_order_id", id).order("at"),
      supabase
        .from("affiliates")
        .select("id, display_name, kind, city, region, can_egr, can_oil_soaked, is_in_house")
        .eq("active", true)
        .order("display_name"),
      supabase.from("catalog_items").select("id, sku, name, category, oe_cross, price_per_line").eq("active", true).order("sku"),
      loadLocationCounts(supabase),
      supabase.from("customer_billing").select("tax_exempt").eq("customer_id", wo.customer_id).maybeSingle(),
      supabase.from("inbound_emails").select(EMAIL_COLUMNS).eq("work_order_id", id).order("received_at", { ascending: false }),
      supabase.from("work_order_notes").select("id, author_name, created_at, body").eq("work_order_id", id).order("created_at"),
      supabase
        .from("work_order_internal_notes")
        .select("id, author_name, created_at, body")
        .eq("work_order_id", id)
        .order("created_at"),
    ]);

  // QuickBooks: only for orders that are ready to invoice or invoiced.
  let qbo: QboStatus | null = null;
  let invoice: InvoiceState | null = null;
  let invoiceLoadError = false;
  if (wo.status === "ready_to_invoice" || wo.status === "invoiced") {
    try {
      [qbo, invoice] = await Promise.all([qboStatus(supabase), loadInvoice(supabase, id)]);
    } catch {
      invoiceLoadError = true;
    }
  }

  const internal = internalRes.data as unknown as Internal | null;
  const fin = finRes.data as Financials | null;
  const lines = (linesRes.data ?? []) as unknown as Line[];
  const components = (compRes.data ?? []) as Component[];
  const requests = (authRes.data ?? []) as unknown as AuthRequest[];
  const attachments = (attRes.data ?? []) as Attachment[];
  const shipments = (shipRes.data ?? []) as unknown as Shipment[];
  const emails = (emailsRes.data ?? []) as InboundEmail[];
  const notes = (notesRes.data ?? []) as NoteView[];
  const internalNotes = internalNotesHistory(internal?.internal_notes, wo.created_at, (internalNotesRes.data ?? []) as NoteView[]);
  const canShip = shipStationConfigured();
  const [labels, packageDefaults] = shipments.length
    ? await Promise.all([activeLabels(supabase, { workOrderId: id }, true), canShip ? defaultPackage(supabase) : null])
    : [new Map<string, LabelView>(), null];
  const events = (eventRes.data ?? []) as WoEvent[];
  const shops = (shopsRes.data ?? []) as ShopRow[];
  const catalog = (catalogRes.data ?? []) as {
    id: string;
    sku: string;
    name: string;
    category: string;
    oe_cross: string | null;
    price_per_line: boolean;
  }[];

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
  // CDS's in-house shop: the shop column is what CDS itself paid (CDS cost), not a shop rate.
  const inHouse = Boolean(shop?.is_in_house);
  const rateLabel = inHouse ? "CDS Cost" : "Shop Rate";
  const location = one(wo.customer_locations);
  const inReview = REVIEW_STATUSES.includes(wo.status);
  const declined = wo.status === "rejected_by_affiliate";

  // Edit order: the customer and Location / Branch picker of Create Work Order, with the
  // locations the email intake matched (when it found more than one) listed first.
  let editCustomers: { id: string; code: string; name: string }[] = [];
  let editLocations: LocationOption[] = [];
  let candidateIds: string[] = [];
  let editLoadError: string | null = null;
  if (inReview) {
    const [custRes, locRes, emailRes] = await Promise.all([
      supabase.from("customers").select("id, code, name").eq("active", true).order("name"),
      loadPickerLocations(supabase),
      supabase.from("inbound_emails").select("parsed->location_candidates").eq("work_order_id", id),
    ]);
    editLoadError = custRes.error?.message ?? locRes.error?.message ?? null;
    editCustomers = (custRes.data ?? []) as { id: string; code: string; name: string }[];
    // The order's own customer stays choosable if it was made inactive.
    if (customer && !editCustomers.some((c) => c.id === wo.customer_id)) {
      editCustomers = [...editCustomers, { id: wo.customer_id, code: customer.code, name: customer.name }];
    }
    editLocations = locRes.data ?? [];
    const rows = (emailRes.data ?? []) as { location_candidates: unknown }[];
    candidateIds = [
      ...new Set(
        rows.flatMap((r) =>
          Array.isArray(r.location_candidates)
            ? r.location_candidates.map((c: { id?: unknown }) => c?.id).filter((v): v is string => isUuid(v))
            : [],
        ),
      ),
    ];
  }
  const linesLocked = LINES_LOCKED_STATUSES.includes(wo.status);
  // Items priced per line (Misc. hardware) come from the shop's invoice, so CDS can add and
  // remove them after the work is completed, until the order is invoiced.
  const perLineOpen = !["invoiced", "cancelled"].includes(wo.status);
  const perLineItems = catalog.filter((c) => c.price_per_line);
  const isPerLine = (l: Line) => one(l.catalog_items)?.price_per_line === true;
  const removeColumn = !linesLocked || (perLineOpen && lines.some(isPerLine));
  const tbd = fin?.supplier_cost_tbd ?? false;
  const approver = one(internal?.profiles ?? null);

  // Tax summary from the line snapshots, the order's tax flags and the customer's tax
  // exemption: the same rule as the QuickBooks invoice (src/lib/tax.ts). Invoiced and
  // cancelled orders show what is stored on them, whatever the customer's exemption is now.
  const customerTaxExempt = orderTaxExempt({
    status: wo.status,
    customerTaxExempt: (billingRes.data as { tax_exempt: boolean } | null)?.tax_exempt ?? false,
    taxSource: internal?.tax_source ?? null,
  });
  const taxFlags: TaxFlags = {
    taxParts: internal?.tax_parts ?? false,
    taxLabor: internal?.tax_labor ?? false,
    taxShipping: internal?.tax_shipping ?? false,
    customerTaxExempt,
  };
  const rate = customerTaxExempt ? 0 : Number(internal?.tax_rate ?? 0);
  let shopTotal = 0;
  for (const l of lines) shopTotal += (l.shop_unit_rate ?? 0) * l.qty;
  const { subtotal, taxable, salesTax, total: invoiceTotal } = taxSummary(
    lines.map((l) => {
      const p = one(l.work_order_line_pricing);
      return { amount: (p?.customer_unit_price ?? 0) * l.qty, taxClass: p?.tax_class ?? null };
    }),
    taxFlags,
    rate,
  );
  const compName = new Map(components.map((c) => [c.id, `${c.component_type} #${c.seq}`]));
  const locationDefault = location?.default_affiliate_id ?? null;
  const defaultShop = dispatchShopDefault({ status: wo.status, affiliateId: wo.affiliate_id, locationDefault });
  // Rates and labels for legs to or from the shop: the order's shop, or while it is in review
  // the planned shop (the Review & Dispatch default, if that shop is still active).
  const labelShopNow = (() => {
    const s = labelShop({ status: wo.status, affiliateId: wo.affiliate_id, locationDefault });
    if (!s) return null;
    if (!s.planned) return { ...s, name: shop?.display_name ?? null };
    const active = shops.find((x) => x.id === s.affiliateId);
    return active ? { ...s, name: active.display_name } : null;
  })();

  // Dispatch picker: the shop the order is with first (unless it declined), then the
  // location's default shop, then the rest by name.
  const currentShop = !declined ? wo.affiliate_id : null;
  const shopRank = (id: string) => (currentShop && id === currentShop ? 0 : id === locationDefault ? 1 : 2);
  const shopOptions: SearchOption[] = [...shops]
    .sort((a, b) => shopRank(a.id) - shopRank(b.id))
    .map((s) => {
      const marks = [
        currentShop && s.id === currentShop ? "(current shop)" : "",
        s.id === locationDefault ? "(location default)" : "",
        declined && s.id === wo.affiliate_id ? "(declined)" : "",
        // Demo shops carry "(demo)" in their name on staging; mark any other "demo" shop too.
        /\bdemo\b/i.test(s.display_name) && !DEMO_RE.test(s.display_name) ? "(demo)" : "",
        s.kind === "parts_supplier" ? "(parts supplier)" : "",
        s.is_in_house ? "(CDS in-house sale)" : "",
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
  const catalogOptions: SearchOption[] = catalog.filter((c) => !c.price_per_line).map((c) => ({
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
            {customer?.name ?? "Unknown customer"} • {wo.location_label} • Unit {wo.unit_number ?? "-"}
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
              <Fact label="Requested work">
                {wo.requested_work}
                {wo.return_to_location ? "\nReturn to the customer's location" : ""}
              </Fact>
              {(wo.vin || wo.mileage !== null) && (
                <Fact label="VIN / mileage">
                  {[wo.vin, wo.mileage !== null ? `${wo.mileage.toLocaleString("en-US")} mi` : null].filter(Boolean).join(" · ")}
                </Fact>
              )}
              {wo.requested_date && <Fact label="Requested date">{wo.requested_date}</Fact>}
              {(internal?.customer_contact_name || internal?.customer_contact_email || internal?.customer_contact_phone) && (
                <Fact label="Customer contact">
                  {[internal.customer_contact_name, internal.customer_contact_email, internal.customer_contact_phone].filter(Boolean).join("\n")}
                </Fact>
              )}
              {(internal?.order_type || internal?.customer_region) && (
                <Fact label="Customer order type / region">{[internal.order_type, internal.customer_region].filter(Boolean).join(" · ")}</Fact>
              )}
              <Fact label="Location">
                {wo.location_label}
                {location?.dock_note ? `\nDock: ${location.dock_note}` : ""}
              </Fact>
              <Fact label="Routing notes">{internal?.routing_notes}</Fact>
              {emails.map((e) => (
                <OriginalEmail key={e.id} email={e} />
              ))}
              {emailsRes.error && (
                <div className="small" style={{ gridColumn: "1 / -1" }}>
                  The original email could not be loaded. Reload the page.
                </div>
              )}
              <Fact label="Created">
                {dateTime(wo.created_at)} ({internal?.source === "manual" ? "manual" : internal?.source})
              </Fact>
              <Fact label="Dispatched / completed / delivered">
                {[
                  wo.dispatched_at && `Dispatched ${dateTime(wo.dispatched_at)}`,
                  wo.completed_at && `Completed ${dateTime(wo.completed_at)}`,
                  wo.delivered_at && `Delivered ${dateTime(wo.delivered_at)}`,
                ]
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
                      {shipmentEta(s) ? ` • ETA ${shipmentEta(s)}` : ""}
                      {s.delivered_at ? ` • Delivered ${dateTime(s.delivered_at)}` : ""}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 850, color: "var(--blue)", margin: "6px 0" }}>
                      Tracking # {s.tracking_number ?? "Pending"}
                    </div>
                    <div className="small">
                      Quoted {money(si?.quoted_cost)} • Actual {money(si?.actual_cost)}
                      {si?.notes ? ` • ${si.notes}` : ""}
                    </div>
                    {canShip && !labels.has(s.id) && missingLegEnds(s.direction, { affiliateId: labelShopNow?.affiliateId ?? null, locationId: wo.location_id }).map((p) => (
                      <div key={p} className="notice warning">
                        {p}. Rates and labels need its address.
                      </div>
                    ))}
                    {(() => {
                      const end = shopEnd(s.direction);
                      const label = labels.get(s.id) ?? null;
                      if (!end) return null;
                      const mismatch = label?.shop ? labelShopMismatch({ shopId: label.shop.id, shopName: label.shop.name }, { shop: labelShopNow, shopName: labelShopNow?.name ?? null }) : null;
                      if (mismatch) return <div className="notice danger">{mismatch}</div>;
                      // Before dispatch: say which shop the label is (or will be) addressed to.
                      if (!labelShopNow?.planned || (!label && !canShip)) return null;
                      return (
                        <div className="small" style={{ marginTop: 4 }}>
                          <b>Label {end === "to" ? "to" : "from"}:</b> {(label?.shop?.name ?? labelShopNow.name) || "the planned shop"} (planned, not yet dispatched)
                        </div>
                      );
                    })()}
                    <div style={{ marginTop: 8 }}>
                      <LabelPanel
                        shipmentId={s.id}
                        woId={wo.id}
                        label={labels.get(s.id) ?? null}
                        configured={canShip}
                        pkg={packageForShipment(s, packageDefaults)}
                      />
                    </div>
                    {!labels.has(s.id) && !s.tracking_number && REMOVABLE_LABEL_STATUSES.includes(s.label_status) && wo.status !== "invoiced" && (
                      <div style={{ marginTop: 8 }}>
                        <ActionForm
                          action={removeShipment.bind(null, wo.id, s.id)}
                          submitLabel="Remove"
                          pendingLabel="..."
                          buttonClass="remove"
                          confirmText="Remove this shipment from the work order? Its notes and costs are removed too."
                        />
                      </div>
                    )}
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
                      <option value="USPS">USPS</option>
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
                    <select id="ship-status" name="status" defaultValue={NEW_SHIPMENT_STATUS}>
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
            <p className="small" style={{ marginTop: 12 }}>
              Add a leg, then get rates and create its label above. Addresses come from the customer location and the shop
              (Shipping settings hold CDS&apos;s phone and address).
            </p>
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
                below the {inHouse ? "CDS cost" : "shop rate"} ({negativeLines.map((l) => one(l.catalog_items)?.sku ?? "item").join(", ")}). Check the
                customer price before dispatch and invoicing.
              </div>
            )}
            <div className="tablewrap">
              <table style={{ minWidth: 820 }}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">{rateLabel}</th>
                    <th className="num">Customer Price</th>
                    <th>Price Source</th>
                    <th>Tax Class</th>
                    <th className="num">Line Margin</th>
                    {removeColumn && <th />}
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={removeColumn ? 8 : 7} className="small" style={{ textAlign: "center" }}>
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
                          {l.description && <div className="small">{l.description}</div>}
                          {isPerLine(l) && <span className="tag">Shop invoice amount, no upcharge</span>}
                          {negative && (
                            <div>
                              <span className={styles.negTag} title={`The customer price is lower than the ${rateLabel.toLowerCase()}`}>
                                Below {rateLabel.toLowerCase()}
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
                          <div className="small">{p ? taxLabel(p.tax_class, taxFlags) : "Non-taxable"}</div>
                        </td>
                        <td className="num money">{l.shop_unit_rate === null ? "TBD" : money(round2(custAmt - shopAmt))}</td>
                        {removeColumn && (
                          <td>
                            {isPerLine(l) && perLineOpen ? (
                              <ActionForm
                                action={removePassThroughLine.bind(null, wo.id, l.id)}
                                submitLabel="Remove"
                                pendingLabel="..."
                                buttonClass="remove"
                                confirmText="Remove this line from the work order?"
                              />
                            ) : (
                              !linesLocked && (
                                <ActionForm
                                  action={removeLine.bind(null, wo.id, l.id)}
                                  submitLabel="Remove"
                                  pendingLabel="..."
                                  buttonClass="remove"
                                  confirmText="Remove this line from the work order?"
                                />
                              )
                            )}
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
                      {removeColumn && <td />}
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
                {inHouse && (
                  <div style={{ width: 150 }}>
                    <label className="small" htmlFor="line-cds-cost">
                      CDS cost each
                    </label>
                    <input
                      id="line-cds-cost"
                      name="cds_cost"
                      className="input"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="From catalog"
                      title="What CDS paid for one. Leave empty to use the CDS cost from the catalog."
                    />
                  </div>
                )}
              </ActionForm>
            ) : (
              <p className="small">Lines are fixed once the work is completed.</p>
            )}
            {perLineOpen &&
              perLineItems.map((item) => (
                <ActionForm
                  key={item.id}
                  action={addPassThroughLine.bind(null, wo.id, item.id)}
                  submitLabel={`+ Add ${item.name}`}
                  inline
                  resetOnSuccess
                  buttonClass="btn btn-secondary"
                  className="summarybox"
                >
                  <div style={{ flex: "1 1 260px" }}>
                    <label className="small" htmlFor={`pass-desc-${item.id}`}>
                      {item.name} (only when the shop&apos;s invoice includes it)
                    </label>
                    <input
                      id={`pass-desc-${item.id}`}
                      name="description"
                      className="input"
                      required
                      maxLength={500}
                      placeholder="What the shop's invoice lists, e.g. bolts and nuts for the kit"
                    />
                  </div>
                  <div style={{ width: 130 }}>
                    <label className="small" htmlFor={`pass-amount-${item.id}`}>
                      Amount on invoice
                    </label>
                    <input
                      id={`pass-amount-${item.id}`}
                      name="amount"
                      className="input"
                      inputMode="decimal"
                      required
                      placeholder="0.00"
                    />
                  </div>
                </ActionForm>
              ))}
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

          <section className="section" id="attachments">
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
                      <th>Added by</th>
                      <th>Shop</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {attachments.map((a) => {
                      const url = signed.get(a.storage_path);
                      const uploader = one(a.profiles);
                      const isImage = (a.mime_type ?? "").startsWith("image/");
                      return (
                        <tr key={a.id}>
                          <td className={wrapCell(a.file_name, a.note)}>
                            {url && isImage && (
                              <a href={url} target="_blank" rel="noreferrer">
                                {/* Signed storage URLs expire, so next/image caching does not fit here. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={url} alt={a.file_name} loading="lazy" className="thumb" style={{ width: 96, height: 64, display: "block", marginBottom: 4 }} />
                              </a>
                            )}
                            <b>{a.file_name}</b>
                            {a.note && <div className="small">{a.note}</div>}
                          </td>
                          <td>{ATTACHMENT_CATEGORY_LABEL[a.category] ?? a.category}</td>
                          <td>{a.component_id ? compName.get(a.component_id) ?? "-" : "-"}</td>
                          <td>
                            <div>{uploaderLabel(uploader, one(a.affiliates)?.display_name ?? null)}</div>
                            <span className="small nowrap">{dateTime(a.uploaded_at)}</span>
                          </td>
                          <td>
                            <div>{a.shop_visible ? <span className="tag blue">shop sees this</span> : <span className="tag">CDS only</span>}</div>
                            <ActionForm
                              action={setAttachmentShopVisible.bind(null, wo.id, a.id, !a.shop_visible)}
                              submitLabel={a.shop_visible ? "Make CDS only" : "Let shop see"}
                              pendingLabel="..."
                              buttonClass="btn"
                            />
                          </td>
                          <td>
                            {url ? (
                              <a className="link" href={url} target="_blank" rel="noreferrer">
                                Open
                              </a>
                            ) : (
                              <span className="small">Unavailable</span>
                            )}
                            {cdsCanDelete(uploader) && (
                              <ActionForm
                                action={deleteCdsAttachment.bind(null, wo.id, a.id)}
                                submitLabel="Delete"
                                pendingLabel="..."
                                buttonClass="remove"
                                confirmText={`Delete ${a.file_name}? The file is removed for good.`}
                              />
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
            <h4 style={{ marginTop: 14 }}>Add photos or files</h4>
            <AttachmentForm
              workOrderId={wo.id}
              components={components.map((c) => ({ id: c.id, label: compName.get(c.id) ?? c.component_type }))}
              actions={{ prepare: prepareCdsUpload, register: registerCdsUpload }}
              variant="cds"
            />
          </section>

          <section className="section" id="internal-notes">
            <h3>Internal notes</h3>
            <p className="small">Only CDS staff see these notes. Shops never do.</p>
            {internalNotesRes.error && <div className="notice danger">Internal notes could not be loaded. Reload the page.</div>}
            <NotesList
              notes={internalNotes}
              actions={(n) =>
                n.id === ORDER_CREATED_NOTE_ID ? null : (
                  <ActionForm
                    action={deleteInternalNote.bind(null, wo.id, n.id)}
                    submitLabel="Delete"
                    pendingLabel="..."
                    buttonClass="remove"
                    confirmText="Delete this internal note?"
                  />
                )
              }
            />
            <ActionForm action={addInternalNote.bind(null, wo.id)} submitLabel="Add internal note" pendingLabel="Adding..." resetOnSuccess>
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="internal-note-body">New internal note (CDS only)</label>
                <textarea id="internal-note-body" name="body" rows={3} maxLength={NOTE_MAX_LENGTH} required />
              </div>
            </ActionForm>
          </section>

          <section className="section" id="notes">
            <h3>Notes (shop can see)</h3>
            <p className="small">
              Shared with the assigned shop: they see these notes and can add their own. For CDS-only notes use Internal notes.
            </p>
            {notesRes.error && <div className="notice danger">Notes could not be loaded. Reload the page.</div>}
            <NotesList
              notes={notes}
              actions={(n) => (
                <ActionForm
                  action={deleteNote.bind(null, wo.id, n.id)}
                  submitLabel="Delete"
                  pendingLabel="..."
                  buttonClass="remove"
                  confirmText="Delete this note? The shop will no longer see it."
                />
              )}
            />
            <ActionForm action={addNote.bind(null, wo.id)} submitLabel="Add note" pendingLabel="Adding..." resetOnSuccess>
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="note-body">New note (the shop sees it)</label>
                <textarea id="note-body" name="body" rows={3} maxLength={NOTE_MAX_LENGTH} required />
              </div>
            </ActionForm>
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
              <ActionForm
                action={dispatchWorkOrder.bind(null, wo.id)}
                saveFirst={{ formId: "edit-order-form", action: updateWorkOrderFields.bind(null, wo.id) }}
                submitLabel="Approve & Dispatch to Affiliate"
                pendingLabel="Dispatching..."
              >
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
              <ActionForm id="edit-order-form" action={updateWorkOrderFields.bind(null, wo.id)} submitLabel="Save Changes">
                <div className="grid2" style={{ gap: 10 }}>
                  <div className="field">
                    <label htmlFor="edit-unit">
                      Unit # <span className="req">*</span>
                    </label>
                    <input id="edit-unit" name="unit_number" className="input" defaultValue={wo.unit_number ?? ""} required maxLength={100} />
                  </div>
                  <div className="field">
                    <label htmlFor="edit-po">PO #</label>
                    <input id="edit-po" name="po_number" className="input" defaultValue={wo.po_number ?? ""} maxLength={100} />
                  </div>
                </div>
                {editLoadError && <div className="notice danger">Could not load customers and locations: {editLoadError}</div>}
                <OrderLocationFields
                  customers={editCustomers}
                  locations={editLocations}
                  candidateIds={candidateIds}
                  initial={{
                    customerId: wo.customer_id,
                    locationId: wo.location_id,
                    locationLabel: wo.location_label,
                    siteAddress: wo.site_address ?? "",
                    requestType: wo.request_type,
                    fulfillment: wo.fulfillment,
                  }}
                />
                <div className="field">
                  <label htmlFor="edit-work">
                    Requested work <span className="req">*</span>
                  </label>
                  <textarea id="edit-work" name="requested_work" rows={3} defaultValue={wo.requested_work} required maxLength={2000} />
                </div>
              </ActionForm>
            </section>
          )}

          {(wo.status === "ready_to_invoice" || wo.status === "invoiced") && (
            <InvoicePanel woId={wo.id} status={wo.status} qbo={qbo} invoice={invoice} loadError={invoiceLoadError} />
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
                <span>{customerTaxExempt ? "Sales tax (customer exempt)" : `Sales tax (${rate}%)`}</span>
                <b className="money">{money(salesTax)}</b>
              </div>
              <div className="summaryrow">
                <span>Customer invoice total</span>
                <b className="money">{money(invoiceTotal)}</b>
              </div>
              <div className="summaryrow">
                <span>{inHouse ? "CDS cost (in-house)" : "Affiliate payable"}</span>
                <b className="money">{tbd ? "TBD" : money(fin?.shop_subtotal ?? shopTotal)}</b>
              </div>
              <div className="summaryrow">
                <span>Gross margin (before tax)</span>
                <b className="money">{tbd ? "TBD" : money(fin?.margin)}</b>
              </div>
            </div>
            {customerTaxExempt && (
              <div className="notice">
                {TAX_FROZEN_STATUSES.includes(wo.status) ? (
                  <>No sales tax on this order: {customer?.name ?? "the customer"} was tax exempt when it was {wo.status}.</>
                ) : (
                  <>
                    {customer?.name ?? "This customer"} is tax exempt: no sales tax on this order, and every line is invoiced
                    as non-taxable in QuickBooks. The exemption is set on the customer.
                  </>
                )}
              </div>
            )}
            {internal && !customerTaxExempt && (
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
