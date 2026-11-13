import "server-only";
import { STATUS_ORDER, type WoStatus } from "@/lib/format";
import type { createClient } from "@/lib/supabase/server";
import { QUESTION_PARAM } from "./question-pending";
import { FROM_SHOP_PARAM } from "./shop-updates";

/**
 * Filters of the CDS dashboard work order table, shared by the dashboard page and the CSV
 * export so both always list the same orders.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export const IN_PROGRESS: WoStatus[] = ["awaiting_acceptance", "accepted", "picked_up", "in_process"];
export const TO_INVOICE: WoStatus[] = ["completed", "delivered", "ready_to_invoice"];

/** Status filter values: a single status, or one of these groups. */
export const GROUPS: Record<string, { label: string; statuses: WoStatus[] }> = {
  in_progress: { label: "In Progress (all)", statuses: IN_PROGRESS },
  to_invoice: { label: "Ready to Invoice (all)", statuses: TO_INVOICE },
  attention: { label: "Pending Review + Declined", statuses: ["pending_review", "rejected_by_affiliate"] },
};
export const ALL_STATUSES: WoStatus[] = [...STATUS_ORDER, "rejected_by_affiliate"];
/**
 * Status filter value for the orders with at least one condemned component. Condemned is a
 * component result, not a work order status, so it is not one of ALL_STATUSES.
 */
export const CONDEMNED = "condemned";

export type WoFilters = {
  q: string;
  /** The raw status parameter when it is a known group or status, else "". */
  status: string;
  statuses: WoStatus[] | null;
  /** Shop filter: "" (any shop), IN_HOUSE (CDS's own in-house sales) or a shop id. */
  shop: string;
  /** Only work orders with shop activity CDS has not opened yet ("New from shop"). */
  fromShop: boolean;
  /** Only work orders with a customer question pending ("Question Pending", CDS only). */
  question: boolean;
  /** Only work orders with at least one condemned component (status parameter CONDEMNED). */
  condemned: boolean;
};

/** Shop filter value for CDS's own in-house sales (the shop with is_in_house). */
export const IN_HOUSE = "in_house";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseShop(raw: string): string {
  return raw === IN_HOUSE || UUID_RE.test(raw) ? raw : "";
}

/** Strips characters that have meaning in a PostgREST filter string. */
function cleanSearch(q: string): string {
  return q.replace(/[,()*%\\:"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function param(sp: Params, key: string): string {
  const v = sp instanceof URLSearchParams ? sp.get(key) : sp[key];
  return typeof v === "string" ? v : "";
}

export function parseFilters(sp: Params): WoFilters {
  const q = cleanSearch(param(sp, "q"));
  const shop = parseShop(param(sp, "shop"));
  const fromShop = param(sp, FROM_SHOP_PARAM) === "1";
  const question = param(sp, QUESTION_PARAM) === "1";
  const raw = param(sp, "status");
  const group = GROUPS[raw];
  if (group) return { q, status: raw, statuses: group.statuses, shop, fromShop, question, condemned: false };
  if (ALL_STATUSES.includes(raw as WoStatus)) return { q, status: raw, statuses: [raw as WoStatus], shop, fromShop, question, condemned: false };
  if (raw === CONDEMNED) return { q, status: raw, statuses: null, shop, fromShop, question, condemned: true };
  return { q, status: "", statuses: null, shop, fromShop, question, condemned: false };
}

/** Query string for links that keep the current filters ("" when there are none). */
export function filterQuery(f: WoFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.status) p.set("status", f.status);
  if (f.shop) p.set("shop", f.shop);
  if (f.fromShop) p.set(FROM_SHOP_PARAM, "1");
  if (f.question) p.set(QUESTION_PARAM, "1");
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Matches no work order. */
const NO_ID = "00000000-0000-0000-0000-000000000000";
/**
 * Upper bound of flagged orders the "New from shop" and "Question Pending" filters list (the most recent shop
 * activity first); it matches the dashboard's 200 rows and keeps the request URL short.
 */
const MAX_FLAGGED = 200;

/**
 * The filtered work order query, from public.work_order_list: most pressing status first
 * (list_rank, the order of CDS's tracking sheet), then newest first. Search matches WO
 * number, PO, unit, location, customer name and the shipments' tracking numbers (spaces and
 * case ignored). Wrapped in an object because the query builder is thenable and an async
 * function would otherwise run it.
 */
export async function filteredWorkOrders(supabase: Supabase, f: WoFilters, columns: string) {
  // Condemned: an inner join on the condemned components keeps only the orders that have one
  // (under its own name, so the row's own component list stays complete).
  const select = f.condemned ? `${columns}, condemned_components:work_order_components!inner(id)` : columns;
  let list = supabase
    .from("work_order_list")
    .select(select)
    .order("list_rank", { ascending: true })
    .order("created_at", { ascending: false })
    .order("id");
  if (f.condemned) list = list.eq("condemned_components.result", "condemned");
  if (f.statuses) list = f.statuses.length === 1 ? list.eq("status", f.statuses[0]) : list.in("status", f.statuses);
  if (f.shop === IN_HOUSE) {
    const { data: inHouse } = await supabase.from("affiliates").select("id").eq("is_in_house", true).maybeSingle();
    // No in-house shop: nothing matches.
    list = list.eq("affiliate_id", (inHouse as { id: string } | null)?.id ?? NO_ID);
  } else if (f.shop) {
    list = list.eq("affiliate_id", f.shop);
  }
  if (f.fromShop) {
    // The flagged orders are few (cleared as CDS opens them); none flagged: nothing matches.
    const { data: flagged, error } = await supabase
      .from("work_order_shop_activity")
      .select("work_order_id")
      .eq("is_new", true)
      .order("shop_activity_at", { ascending: false })
      .limit(MAX_FLAGGED);
    if (error) throw new Error(`New from shop not loaded: ${error.message}`);
    const ids = ((flagged ?? []) as { work_order_id: string }[]).map((r) => r.work_order_id);
    list = list.in("id", ids.length ? ids : [NO_ID]);
  }
  if (f.question) {
    // Few orders have a question open at a time; none: nothing matches. Combined with the
    // New from shop filter, both id lists apply (an order must be in each).
    const { data: open, error } = await supabase
      .from("work_order_questions")
      .select("work_order_id")
      .eq("question_pending", true)
      .order("set_at", { ascending: false })
      .limit(MAX_FLAGGED);
    if (error) throw new Error(`Question Pending not loaded: ${error.message}`);
    const ids = ((open ?? []) as { work_order_id: string }[]).map((r) => r.work_order_id);
    list = list.in("id", ids.length ? ids : [NO_ID]);
  }
  if (f.q) {
    const { data: custs } = await supabase.from("customers").select("id").ilike("name", `%${f.q}%`).limit(100);
    const like = `"*${f.q}*"`;
    const ors = [`po_number.ilike.${like}`, `unit_number.ilike.${like}`, `location_label.ilike.${like}`];
    const woDigits = f.q.replace(/^wo\s*-?\s*/i, "");
    if (/^\d{1,12}$/.test(woDigits)) ors.push(`wo_number.eq.${woDigits}`);
    const custIds = (custs ?? []).map((c: { id: string }) => c.id);
    if (custIds.length) ors.push(`customer_id.in.(${custIds.join(",")})`);
    // tracking_search holds the tracking numbers without spaces, in lower case.
    const tracking = f.q.replace(/\s+/g, "").toLowerCase();
    if (tracking) ors.push(`tracking_search.ilike."*${tracking}*"`);
    list = list.or(ors.join(","));
  }
  return { query: list };
}

export type Financials = {
  work_order_id: string;
  shop_subtotal: number;
  customer_subtotal: number;
  margin: number;
  supplier_cost_tbd: boolean;
};

/** Financials for the given orders, fetched in chunks to keep URLs short. */
export async function financialsFor(supabase: Supabase, ids: string[]): Promise<Map<string, Financials>> {
  const out = new Map<string, Financials>();
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  // A few requests at a time so a large export does not open hundreds of connections.
  for (let i = 0; i < chunks.length; i += 8) {
    const results = await Promise.all(
      chunks.slice(i, i + 8).map((part) =>
        supabase
          .from("work_order_financials")
          .select("work_order_id, shop_subtotal, customer_subtotal, margin, supplier_cost_tbd")
          .in("work_order_id", part),
      ),
    );
    for (const res of results) {
      if (res.error) throw new Error(res.error.message);
      for (const f of (res.data ?? []) as Financials[]) out.set(f.work_order_id, f);
    }
  }
  return out;
}

/** Table status labels: short enough for the dashboard table; the full label goes in a title. */
export const TABLE_STATUS_LABEL: Partial<Record<WoStatus, string>> = {
  awaiting_acceptance: "Awaiting Acceptance",
  rejected_by_affiliate: "Declined by Shop",
};

// ---------------------------------------------------------------- Pacific periods

const TZ = "America/Los_Angeles";

export type PeriodKey = "month" | "last_month" | "ytd" | "all";

export const PERIODS: { value: PeriodKey; label: string }[] = [
  { value: "month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "ytd", label: "Year to Date" },
  { value: "all", label: "All Time" },
];

function pacificYearMonth(d: Date): { y: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month") };
}

/** The UTC instant of 00:00 Pacific on the first day of a month (m is 1 to 12, may overflow). */
function pacificMonthStart(y: number, m: number): Date {
  const base = new Date(Date.UTC(y, m - 1, 1));
  // Pacific is UTC-7 (PDT) or UTC-8 (PST); pick the offset that lands on local midnight.
  for (const offset of [7, 8]) {
    const t = new Date(base.getTime() + offset * 3600_000);
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(t);
    if (Number(hour) === 0) return t;
  }
  return new Date(base.getTime() + 8 * 3600_000);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Start (inclusive) and end (exclusive) of a dashboard period in Pacific time, plus its label. */
export function periodRange(key: PeriodKey, now = new Date()): { from: Date | null; to: Date | null; label: string } {
  const { y, m } = pacificYearMonth(now);
  switch (key) {
    case "last_month": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: pacificMonthStart(py, pm), to: pacificMonthStart(y, m), label: `${MONTHS[pm - 1]} ${py}` };
    }
    case "ytd":
      return { from: pacificMonthStart(y, 1), to: null, label: `YTD ${y}` };
    case "all":
      return { from: null, to: null, label: "All Time" };
    default:
      return { from: pacificMonthStart(y, m), to: null, label: `${MONTHS[m - 1]} ${y}` };
  }
}

export function parsePeriod(v: unknown): PeriodKey {
  return PERIODS.some((p) => p.value === v) ? (v as PeriodKey) : "month";
}
