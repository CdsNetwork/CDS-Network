import "server-only";
import { SHOP_DEDUCTION_COLUMNS, toShopDeductions, type ShopDeduction } from "@/lib/shop-deductions";
import { createClient } from "@/lib/supabase/server";
import { CATEGORY_LABEL, money } from "@/lib/format";
import { pacificToday } from "@/lib/dates";
import { fetchAllSettled } from "@/lib/supabase/fetch-all";
import { pickShopRatesByItem } from "@/lib/shop-rates";
import { isCustomerItem, lineItemFor } from "@/lib/customer-items";
import type { NoteView } from "@/lib/notes";
import {
  TAB_STATUSES,
  type AttachmentView,
  type AuthRequestRow,
  type ComponentRow,
  type JobRow,
  type LineRow,
  type CatalogOption,
  type QueueJob,
  type QueueTab,
  type ShipmentRow,
} from "@/components/shop/types";

// Every read here uses the signed-in shop's own client, so RLS limits rows to this shop.
// Only shop-visible tables are queried; no customer prices, margins or CDS notes.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

type Named = { name: string } | null;
type Item = { sku: string; name: string; category?: string } | null;

const COMPLETED_LIMIT = 50;

/** Characters that would change a PostgREST filter expression; dropped from a search. */
const FILTER_CHARS = /[,()*%\\"':]/g;

/** Cleans a queue search: trimmed, at most 60 characters, no filter syntax. */
export function cleanQueueSearch(raw: string | undefined): string {
  return (raw ?? "").replace(FILTER_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * The shop's work queue. With `search`, only jobs whose WO number, unit, PO, customer or
 * location match are returned, and the counts are the counts of matches.
 */
export async function loadQueue(
  search = "",
): Promise<{ jobs: Record<QueueTab, QueueJob[]>; counts: Record<QueueTab, number> }> {
  const supabase = await createClient();
  const cols = "id, wo_number, status, location_label, requested_work, unit_number, po_number, customers(name)";

  // One OR filter shared by the three queries. Customer names are looked up first (RLS
  // only returns customers on this shop's own work orders).
  let filter: string | null = null;
  if (search) {
    const like = `*${search}*`;
    const parts = [`unit_number.ilike.${like}`, `po_number.ilike.${like}`, `location_label.ilike.${like}`];
    const woNumber = search.replace(/^wo[\s-]*/i, "");
    if (/^\d{1,9}$/.test(woNumber)) parts.push(`wo_number.eq.${Number(woNumber)}`);
    const { data: customers } = await supabase.from("customers").select("id").ilike("name", `%${search}%`).limit(200);
    const ids = (customers ?? []).map((c) => c.id as string);
    if (ids.length) parts.push(`customer_id.in.(${ids.join(",")})`);
    filter = parts.join(",");
  }
  const where = <Q extends { or: (f: string) => Q }>(q: Q): Q => (filter ? q.or(filter) : q);

  const [open, done, doneCount] = await Promise.all([
    // Every open job (no cap): read in pages past the 1000 row API limit.
    fetchAllSettled((from, to) =>
      where(
        supabase
          .from("work_orders")
          .select(cols)
          .in("status", [...TAB_STATUSES.awaiting, ...TAB_STATUSES.active]),
      )
        .order("wo_number", { ascending: false })
        .range(from, to),
    ),
    where(supabase.from("work_orders").select(cols).in("status", TAB_STATUSES.completed))
      .order("wo_number", { ascending: false })
      .limit(COMPLETED_LIMIT),
    where(
      supabase
        .from("work_orders")
        .select("id", { count: "exact", head: true })
        .in("status", TAB_STATUSES.completed),
    ),
  ]);

  const toJob = (r: Record<string, unknown>): QueueJob => ({
    id: r.id as string,
    wo_number: r.wo_number as number,
    status: r.status as QueueJob["status"],
    location_label: r.location_label as string,
    requested_work: r.requested_work as string,
    unit_number: (r.unit_number as string | null) ?? "",
    po_number: (r.po_number as string | null) ?? null,
    customer_name: (r.customers as Named)?.name ?? "",
  });

  const openJobs = (open.data ?? []).map(toJob);
  const jobs: Record<QueueTab, QueueJob[]> = {
    awaiting: openJobs.filter((j) => TAB_STATUSES.awaiting.includes(j.status)),
    active: openJobs.filter((j) => TAB_STATUSES.active.includes(j.status)),
    completed: (done.data ?? []).map(toJob),
  };
  return {
    jobs,
    counts: {
      awaiting: jobs.awaiting.length,
      active: jobs.active.length,
      completed: doneCount.count ?? jobs.completed.length,
    },
  };
}

export type JobDetailData = {
  job: JobRow;
  lines: LineRow[];
  components: ComponentRow[];
  authRequests: AuthRequestRow[];
  attachments: AttachmentView[];
  shipments: ShipmentRow[];
  /** Notes shared with CDS, oldest first (RLS: only this shop's time on the job). */
  notes: NoteView[];
  /** Parts the shop may add, with its own pay rate in the hint. */
  partOptions: CatalogOption[];
  /** Whole active catalog for extra work requests, with the request kind. */
  authOptions: (CatalogOption & { kind: "service" | "part" })[];
  /** The job belongs to CDS's in-house shop: no invoice number asked on completion. */
  inHouse: boolean;
  /** An in-house parts-only order (CDS sells the part): completes without components. */
  partsSale: boolean;
  /** Automatic deductions on the shop's bill (shipped orders: $15 per filter). */
  deductions: ShopDeduction[];
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function loadJob(id: string, editable: (job: JobRow) => boolean): Promise<JobDetailData | null> {
  if (!isUuid(id)) return null;
  const supabase = await createClient();

  const { data: wo } = await supabase
    .from("work_orders")
    .select(
      "id, wo_number, status, market, fulfillment, location_label, site_address, unit_number, po_number, " +
        "requested_work, pickup_window, shop_ship_status, affiliate_invoice_ref, completed_at, customer_id, affiliate_id, request_type, customers(name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!wo) return null;
  const w = wo as unknown as Omit<JobRow, "customer_name"> & {
    customers: Named;
    customer_id: string;
    affiliate_id: string | null;
    request_type: string;
  };
  const job: JobRow = { ...w, customer_name: w.customers?.name ?? "" };
  delete (job as Partial<typeof w>).customers;
  // Only to pick the shop's rate for this order's customer; not part of JobRow.
  delete (job as Partial<typeof w>).customer_id;
  delete (job as Partial<typeof w>).affiliate_id;
  delete (job as Partial<typeof w>).request_type;

  const [lines, components, auths, files, ships, notes, deductions] = await Promise.all([
    supabase
      .from("work_order_lines")
      .select("id, qty, shop_unit_rate, origin, description, created_at, catalog_items(sku, name)")
      .eq("work_order_id", id)
      .order("created_at"),
    supabase
      .from("work_order_components")
      .select(
        "id, seq, component_type, manufacturer, part_number, serial_number, dp_before, dp_after, " +
          "weight_before_g, weight_after_g, result, result_note",
      )
      .eq("work_order_id", id)
      .order("seq"),
    supabase
      .from("authorization_requests")
      .select("id, seq, kind, qty, note, status, requested_at, catalog_items(sku, name)")
      .eq("work_order_id", id)
      .order("seq"),
    supabase
      .from("attachments")
      .select("id, component_id, category, storage_path, file_name, mime_type, note, uploaded_at, affiliate_id")
      .eq("work_order_id", id)
      .order("uploaded_at"),
    supabase
      .from("shipments")
      .select("id, direction, carrier, tracking_number, status, created_at")
      .eq("work_order_id", id)
      .order("created_at"),
    supabase.from("work_order_notes").select("id, author_name, created_at, body").eq("work_order_id", id).order("created_at"),
    supabase.from("work_order_shop_deductions").select(SHOP_DEDUCTION_COLUMNS).eq("work_order_id", id),
  ]);

  const lineRows: LineRow[] = (lines.data ?? []).map((r) => {
    const item = r.catalog_items as unknown as Item;
    return {
      id: r.id,
      qty: Number(r.qty),
      shop_unit_rate: num(r.shop_unit_rate),
      origin: r.origin,
      description: r.description ?? null,
      sku: item?.sku ?? "",
      name: item?.name ?? "",
    };
  });

  const componentRows: ComponentRow[] = ((components.data ?? []) as unknown as ComponentRow[]).map((c) => ({
    ...c,
    dp_before: num(c.dp_before),
    dp_after: num(c.dp_after),
    weight_before_g: num(c.weight_before_g),
    weight_after_g: num(c.weight_after_g),
  }));

  const authRows: AuthRequestRow[] = (auths.data ?? []).map((r) => {
    const item = r.catalog_items as unknown as Item;
    return {
      id: r.id,
      seq: r.seq,
      kind: r.kind,
      qty: Number(r.qty),
      note: r.note,
      status: r.status,
      requested_at: r.requested_at,
      sku: item?.sku ?? "",
      name: item?.name ?? "",
    };
  });

  // Signed URLs with the user's own client: the storage policy only lets this shop read
  // files attached to its own work orders.
  const fileRows = files.data ?? [];
  const urls = new Map<string, string>();
  if (fileRows.length) {
    const { data: signed } = await supabase.storage
      .from("wo-files")
      .createSignedUrls(
        fileRows.map((f) => f.storage_path),
        60 * 60,
      );
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  const attachments: AttachmentView[] = fileRows.map((f) => ({
    id: f.id,
    component_id: f.component_id,
    category: f.category,
    file_name: f.file_name,
    mime_type: f.mime_type,
    note: f.note,
    uploaded_at: f.uploaded_at,
    from_cds: f.affiliate_id === null,
    url: urls.get(f.storage_path) ?? null,
  }));

  // Labels CDS created for this job: shops print them (the return leg) and see the ship-to.
  const { data: labelRows } = (ships.data ?? []).length
    ? await supabase
        .from("shipment_labels")
        .select("id, shipment_id, service_name, tracking_number, is_test")
        .eq("work_order_id", id)
        .eq("status", "active")
    : { data: [] };
  const labelByShipment = new Map((labelRows ?? []).map((l) => [l.shipment_id as string, l]));

  const shipments: ShipmentRow[] = (ships.data ?? []).map((s) => {
    const l = labelByShipment.get(s.id);
    return {
      id: s.id,
      direction: s.direction,
      carrier: s.carrier,
      tracking_number: s.tracking_number,
      status: s.status,
      label: l ? { id: l.id, service_name: l.service_name, tracking_number: l.tracking_number, is_test: l.is_test } : null,
    };
  });

  // RLS: a shop reads its own affiliate row only.
  const { data: shopRow } = w.affiliate_id
    ? await supabase.from("affiliates").select("is_in_house").eq("id", w.affiliate_id).maybeSingle()
    : { data: null };
  const inHouse = Boolean((shopRow as { is_in_house?: boolean } | null)?.is_in_house);

  let partOptions: CatalogOption[] = [];
  let authOptions: JobDetailData["authOptions"] = [];
  if (editable(job)) {
    ({ partOptions, authOptions } = await loadCatalogOptions(job.market, w.affiliate_id, w.customer_id, inHouse));
  }

  return {
    job,
    lines: lineRows,
    components: componentRows,
    authRequests: authRows,
    attachments,
    shipments,
    notes: (notes.data ?? []) as NoteView[],
    partOptions,
    authOptions,
    inHouse,
    partsSale: inHouse && w.request_type === "parts_only",
    deductions: toShopDeductions(deductions.data as Record<string, unknown>[] | null),
  };
}

async function loadCatalogOptions(market: string, shop: string | null, customer: string, inHouse: boolean) {
  const supabase = await createClient();
  const today = pacificToday();

  const [items, rates] = await Promise.all([
    supabase
      .from("catalog_items")
      .select("id, sku, name, category, oe_cross, shop_selectable, variant_of, variant_customer_id")
      .eq("active", true)
      .order("sku"),
    // RLS returns the default rows plus this shop's own rows only (each with or without a
    // customer). Paged so a larger catalog never passes the 1000 row cap.
    fetchAllSettled((from, to) =>
      supabase
        .from("shop_rates")
        .select("catalog_item_id, affiliate_id, customer_id, amount, effective_from, effective_to")
        .eq("market", market)
        .lte("effective_from", today)
        .or(`effective_to.is.null,effective_to.gt.${today}`)
        .order("id")
        .range(from, to),
    ),
  ]);

  // Same rule as the database: the most specific rate for this shop and this order's customer
  // (for the in-house shop, only its own rows: CDS's own cost).
  const best = pickShopRatesByItem(rates.data ?? [], shop, customer, inHouse);

  const all = items.data ?? [];
  // Only shop-safe text: SKU, name, category, OE cross reference and the shop's own rate.
  const base = (i: (typeof all)[number]) => ({
    id: i.id as string,
    label: `${i.sku} - ${i.name}`,
    category: CATEGORY_LABEL[i.category as string] ?? String(i.category),
    keywords: (i.oe_cross as string | null) ?? undefined,
  });
  // A part the shop picks may become this customer's own item (First Student's AM gaskets
  // and clamps, private.use_customer_item): its rate is the one shown. Customer items are
  // never picked by hand.
  const refs = all.map((i) => ({
    id: i.id as string,
    variant_of: (i.variant_of as string | null) ?? null,
    variant_customer_id: (i.variant_customer_id as string | null) ?? null,
  }));
  const pickable = all.filter((i) => !isCustomerItem({ variant_of: (i.variant_of as string | null) ?? null }));
  const partOptions: CatalogOption[] = pickable
    .filter((i) => i.shop_selectable && i.category !== "service")
    .map((i) => {
      const amount = num(best.get(lineItemFor(i.id as string, customer, refs))?.amount ?? null);
      const o = base(i);
      const rate = amount === null ? "Rate set by CDS" : `Your rate ${money(amount)}`;
      return { ...o, hint: `${o.category} • ${rate}` };
    });
  const authOptions = pickable.map((i) => {
    const o = base(i);
    return { ...o, hint: o.category, kind: (i.category === "service" ? "service" : "part") as "service" | "part" };
  });
  return { partOptions, authOptions };
}
