import "server-only";
import { loadShopDeductions, type ShopDeduction } from "@/lib/shop-deductions";
import { createClient } from "@/lib/supabase/server";
import { CATEGORY_LABEL, money } from "@/lib/format";
import { pacificToday } from "@/lib/dates";
import { addDays } from "@/lib/pickup";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { pickShopRatesByItem } from "@/lib/shop-rates";
import { isCustomerItem, lineItemFor } from "@/lib/customer-items";
import { receivedAt, shopCanSeeLabel, shopTimeline, type TimelineStep } from "@/components/shop/shop-dates";
import { monthRange, type CalendarJob } from "@/components/shop/calendar";
import type { NoteView } from "@/lib/notes";
import { shopCanRemove } from "@/lib/attachments";
import {
  isPartsSale,
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
//
// A failed read throws (the page then shows an error) instead of reading as "no rows": a
// failed queue read is not an empty queue, and a failed line or deduction read must never
// give a settlement total from partly loaded inputs.

/** The rows of a required read, or an error naming what could not be loaded. */
function required<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`Could not load ${what}: ${res.error.message}`);
  return res.data;
}

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
 * The shop's work queue. With `search`, only jobs whose WO number, unit, PO, part number, customer or
 * location match are returned, and the counts are the counts of matches.
 */
export async function loadQueue(
  search = "",
): Promise<{ jobs: Record<QueueTab, QueueJob[]>; counts: Record<QueueTab, number> }> {
  const supabase = await createClient();
  // The inbound legs' delivery times give the Received date (shop-dates receivedAt).
  const cols =
    "id, wo_number, status, location_label, requested_work, unit_number, po_number, customer_part_number, customer_manufacturer, dispatched_at, picked_up_at, completed_at, customers(name), shipments(direction, delivered_at)";

  // One OR filter shared by the three queries. Customer names are looked up first (RLS
  // only returns customers on this shop's own work orders).
  let filter: string | null = null;
  if (search) {
    const like = `*${search}*`;
    const parts = [`unit_number.ilike.${like}`, `po_number.ilike.${like}`, `customer_part_number.ilike.${like}`, `location_label.ilike.${like}`];
    const woNumber = search.replace(/^wo[\s-]*/i, "");
    if (/^\d{1,9}$/.test(woNumber)) parts.push(`wo_number.eq.${Number(woNumber)}`);
    const customers = required(
      await supabase.from("customers").select("id").ilike("name", `%${search}%`).limit(200),
      "the customers for the search",
    );
    const ids = (customers ?? []).map((c) => c.id as string);
    if (ids.length) parts.push(`customer_id.in.(${ids.join(",")})`);
    filter = parts.join(",");
  }
  const where = <Q extends { or: (f: string) => Q }>(q: Q): Q => (filter ? q.or(filter) : q);

  const [open, done, doneCount] = await Promise.all([
    // Every open job (no cap): read in pages past the 1000 row API limit.
    fetchAll((from, to) =>
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
    customer_part_number: (r.customer_part_number as string | null) ?? null,
    customer_manufacturer: (r.customer_manufacturer as string | null) ?? null,
    customer_name: (r.customers as Named)?.name ?? "",
    dispatched_at: (r.dispatched_at as string | null) ?? null,
    received_at: receivedAt(
      { picked_up_at: (r.picked_up_at as string | null) ?? null },
      r.shipments as { direction: string; delivered_at: string | null }[] | null,
    ),
    completed_at: (r.completed_at as string | null) ?? null,
  });

  required(done, "the completed jobs");
  required(doneCount, "the completed job count");
  const openJobs = open.map(toJob);
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

const CALENDAR_STATUSES = [...TAB_STATUSES.awaiting, ...TAB_STATUSES.active, ...TAB_STATUSES.completed];
const CALENDAR_COLS =
  "id, wo_number, status, fulfillment, location_label, unit_number, pickup_date, pickup_window, picked_up_at, customers(name), shipments(direction, delivered_at)";

/**
 * The shop's jobs with a calendar date in `month` (YYYY-MM): pickup jobs whose pickup day is in
 * the month, and other jobs whose part arrived at the shop around the month (the calendar keeps
 * the Pacific days of the month). Same jobs as the job list: this shop's own (RLS), list statuses.
 */
export async function loadCalendar(month: string): Promise<CalendarJob[]> {
  const supabase = await createClient();
  const { first, last } = monthRange(month);

  const [pickups, arrivals] = await Promise.all([
    fetchAll((from, to) =>
      supabase
        .from("work_orders")
        .select(CALENDAR_COLS)
        .eq("fulfillment", "pickup")
        .in("status", CALENDAR_STATUSES)
        .gte("pickup_date", first)
        .lte("pickup_date", last)
        .order("id")
        .range(from, to),
    ),
    // Inbound deliveries with a day of margin either side of the month (Pacific vs UTC).
    fetchAll((from, to) =>
      supabase
        .from("shipments")
        .select("work_order_id")
        .eq("direction", "customer_to_affiliate")
        .gte("delivered_at", `${addDays(first, -1)}T00:00:00Z`)
        .lt("delivered_at", `${addDays(last, 2)}T00:00:00Z`)
        .order("id")
        .range(from, to),
    ),
  ]);

  const ids = [...new Set(arrivals.map((r) => r.work_order_id as string))];
  const shipped: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = required(
      await supabase
        .from("work_orders")
        .select(CALENDAR_COLS)
        .in("id", ids.slice(i, i + 100))
        .neq("fulfillment", "pickup")
        .in("status", CALENDAR_STATUSES),
      "the shipped jobs",
    );
    shipped.push(...((chunk ?? []) as unknown as Record<string, unknown>[]));
  }

  return [...(pickups as Record<string, unknown>[]), ...shipped].map((r) => ({
    id: r.id as string,
    wo_number: r.wo_number as number,
    status: r.status as CalendarJob["status"],
    fulfillment: r.fulfillment as string,
    customer_name: (r.customers as Named)?.name ?? "",
    location_label: r.location_label as string,
    unit_number: (r.unit_number as string | null) ?? "",
    pickup_date: (r.pickup_date as string | null) ?? null,
    pickup_window: (r.pickup_window as string | null) ?? null,
    received_at: receivedAt(
      { picked_up_at: (r.picked_up_at as string | null) ?? null },
      r.shipments as { direction: string; delivered_at: string | null }[] | null,
    ),
  }));
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
  /** The job belongs to CDS's in-house shop: its bill number is optional on completion (IN-HOUSE-<wo> when empty). */
  inHouse: boolean;
  /** A parts-only order (any shop): completes without components or measurements. */
  partsSale: boolean;
  /** Automatic deductions on the shop's bill (shipped orders: $15 per filter or EGR cooler). */
  deductions: ShopDeduction[];
  /** When the shop received the part (inbound delivery, else Picked Up), or null. */
  receivedAt: string | null;
  /** The steps that happened (Dispatched, Accepted, Picked up or Received, Completed, Returned). */
  timeline: TimelineStep[];
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function loadJob(id: string, editable: (job: JobRow) => boolean): Promise<JobDetailData | null> {
  if (!isUuid(id)) return null;
  const supabase = await createClient();

  const wo = required(
    await supabase
      .from("work_orders")
      .select(
        "id, wo_number, status, market, fulfillment, location_label, site_address, unit_number, po_number, customer_part_number, customer_manufacturer, " +
          "requested_work, pickup_window, pickup_date, shop_ship_status, affiliate_invoice_ref, dispatched_at, accepted_at, picked_up_at, completed_at, delivered_at, " +
          "customer_id, affiliate_id, request_type, customers(name)",
      )
      .eq("id", id)
      .maybeSingle(),
    "the job",
  );
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
      .select("id, component_id, category, storage_path, file_name, mime_type, note, uploaded_at, affiliate_id, uploaded_by")
      .eq("work_order_id", id)
      .order("uploaded_at"),
    supabase
      .from("shipments")
      .select("id, direction, carrier, tracking_number, status, delivered_at, created_at")
      .eq("work_order_id", id)
      .order("created_at"),
    supabase.from("work_order_notes").select("id, author_name, created_at, body").eq("work_order_id", id).order("created_at"),
    // The shared loader: it throws when the deduction read fails.
    loadShopDeductions(supabase, id),
  ]);
  required(lines, "the job lines");
  required(components, "the components");
  required(auths, "the extra work requests");
  required(files, "the attachments");
  required(ships, "the shipments");
  required(notes, "the notes");

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
    can_remove: shopCanRemove(job.status, { fromCds: f.affiliate_id === null, uploadedBy: f.uploaded_by }),
    url: urls.get(f.storage_path) ?? null,
  }));

  // Labels CDS created for this job: the shop prints the label of the leg back to the
  // customer only (RLS returns no other label; checked here as well). Inbound legs keep their
  // tracking number.
  const labelRows = (ships.data ?? []).some((s) => shopCanSeeLabel(s.direction))
    ? required(
        await supabase
          .from("shipment_labels")
          .select("id, shipment_id, service_name, tracking_number, is_test")
          .eq("work_order_id", id)
          .eq("status", "active"),
        "the shipping labels",
      )
    : [];
  const labelByShipment = new Map((labelRows ?? []).map((l) => [l.shipment_id as string, l]));

  const shipments: ShipmentRow[] = (ships.data ?? []).map((s) => {
    const l = shopCanSeeLabel(s.direction) ? labelByShipment.get(s.id) : undefined;
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
  const shopRow = w.affiliate_id
    ? required(await supabase.from("affiliates").select("is_in_house").eq("id", w.affiliate_id).maybeSingle(), "the shop")
    : null;
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
    partsSale: isPartsSale(w.request_type),
    deductions,
    receivedAt: receivedAt(job, ships.data ?? []),
    timeline: shopTimeline(job, ships.data ?? []),
  };
}

async function loadCatalogOptions(market: string, shop: string | null, customer: string, inHouse: boolean) {
  const supabase = await createClient();
  const today = pacificToday();

  const [items, rates] = await Promise.all([
    supabase
      .from("catalog_items")
      .select("id, sku, name, category, oe_cross, shop_selectable, variant_of, variant_customer_id, price_per_line, pass_through")
      .eq("active", true)
      .order("sku"),
    // RLS returns the default rows plus this shop's own rows only (each with or without a
    // customer). Paged so a larger catalog never passes the 1000 row cap.
    fetchAll((from, to) =>
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
  const best = pickShopRatesByItem(rates, shop, customer, inHouse);

  const all = required(items, "the catalog") ?? [];
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
  // Any part the shop may select, added without asking CDS (Sarah, CDS, 2026-11-23); services
  // need Request Additional Authorization. Misc. hardware (priced per line, pass through) is
  // added at the amount on the shop's invoice. Items CDS prices on each order (reconditioned
  // and new filters) stay CDS's to add (public.shop_add_part).
  const partOptions: CatalogOption[] = pickable
    .filter((i) => i.shop_selectable && i.category !== "service" && !(i.price_per_line && !i.pass_through))
    .map((i) => {
      const o = base(i);
      if (i.price_per_line) return { ...o, hint: `${o.category} • Amount from your invoice`, perLine: true };
      const amount = num(best.get(lineItemFor(i.id as string, customer, refs))?.amount ?? null);
      const rate = amount === null ? "Rate set by CDS" : `Your rate ${money(amount)}`;
      return { ...o, hint: `${o.category} • ${rate}` };
    });
  const authOptions = pickable.map((i) => {
    const o = base(i);
    return { ...o, hint: o.category, kind: (i.category === "service" ? "service" : "part") as "service" | "part" };
  });
  return { partOptions, authOptions };
}
