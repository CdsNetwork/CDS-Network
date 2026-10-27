import Form from "next/form";
import Link from "next/link";
import { PeriodSelect } from "@/components/cds-wo/PeriodSelect";
import styles from "@/components/cds-wo/cds-wo.module.css";
import { one, SHIPMENT_PROBLEM_STATUSES } from "@/components/cds-wo/util";
import {
  ALL_STATUSES,
  filteredWorkOrders,
  filterQuery,
  financialsFor,
  GROUPS,
  IN_PROGRESS,
  parseFilters,
  parsePeriod,
  periodRange,
  PERIODS,
  TABLE_STATUS_LABEL,
  TO_INVOICE,
  type Financials,
} from "@/components/cds-wo/woFilters";
import { requireCds } from "@/lib/auth";
import { money, SHIPMENT_STATUS_LABEL, STATUS_LABEL, woLabel, type WoStatus, wrapCell } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

type Named = { name: string } | null;
type Shop = { display_name: string } | null;

type WoRow = {
  id: string;
  wo_number: number;
  status: WoStatus;
  location_label: string;
  unit_number: string | null;
  po_number: string | null;
  customers: Named | Named[];
  affiliates: Shop | Shop[];
};

type AttentionWo = WoRow & {
  updated_at: string;
  work_order_internal: { review_reason: string | null } | { review_reason: string | null }[] | null;
};

type ProblemShipment = {
  id: string;
  carrier: string | null;
  tracking_number: string | null;
  status: string;
  updated_at: string;
  work_orders: WoRow | WoRow[] | null;
};

type AttentionItem = {
  key: string;
  red: boolean;
  title: string;
  wo: WoRow;
  detail: string;
  /** When the item last changed, for newest-first ordering. */
  at: string;
};

/** Cards shown in Needs Attention; the rest are reachable through the table filter. */
const ATTENTION_SHOWN = 12;

const WO_COLUMNS =
  "id, wo_number, status, location_label, unit_number, po_number, customers(name), affiliates(display_name)";

/** Unit and PO numbers up to this length stay on one line in the table. */
const ID_NOWRAP = 22;

function idClass(value: string | null): string {
  return (value ?? "").length > ID_NOWRAP ? styles.idCol : styles.idShort;
}

export default async function DashboardPage({ searchParams }: PageProps<"/cds">) {
  await requireCds();
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const { q, status: statusParam } = filters;
  const period = parsePeriod(sp.period);
  const range = periodRange(period);

  const supabase = await createClient();
  const countOf = (statuses: WoStatus[]) =>
    supabase.from("work_orders").select("id", { count: "exact", head: true }).in("status", statuses);
  let invoicedQuery = supabase
    .from("work_order_internal")
    .select("work_order_id", { count: "exact", head: true })
    .not("invoiced_at", "is", null);
  if (range.from) invoicedQuery = invoicedQuery.gte("invoiced_at", range.from.toISOString());
  if (range.to) invoicedQuery = invoicedQuery.lt("invoiced_at", range.to.toISOString());

  // Work order table query (same filters as the CSV export).
  const list = (await filteredWorkOrders(supabase, filters, WO_COLUMNS)).query.limit(200);

  // Declined jobs and pending reviews are fetched separately, newest first, so a burst
  // of pending reviews can never push a declined job out of the queue.
  const attentionQuery = (status: WoStatus) =>
    supabase
      .from("work_orders")
      .select(`${WO_COLUMNS}, updated_at, work_order_internal(review_reason)`)
      .eq("status", status)
      .order("updated_at", { ascending: false })
      .limit(100);

  const [listRes, declinedRes, reviewRes, shipRes, inProgress, toInvoice, pendingReview, invoiced] = await Promise.all([
    list,
    attentionQuery("rejected_by_affiliate"),
    attentionQuery("pending_review"),
    supabase
      .from("shipments")
      .select(`id, carrier, tracking_number, status, updated_at, work_orders(${WO_COLUMNS})`)
      .in("status", [...SHIPMENT_PROBLEM_STATUSES])
      .order("updated_at", { ascending: false })
      .limit(100),
    countOf(IN_PROGRESS),
    countOf(TO_INVOICE),
    countOf(["pending_review"]),
    invoicedQuery,
  ]);

  const rows = (listRes.data ?? []) as unknown as WoRow[];

  // Financials for the listed orders.
  let finById = new Map<string, Financials>();
  let finError: string | null = null;
  try {
    finById = await financialsFor(
      supabase,
      rows.map((r) => r.id),
    );
  } catch (e) {
    finError = e instanceof Error ? e.message : "unknown error";
  }

  // Needs Attention items.
  const attention: AttentionItem[] = [];
  const attentionWos = [...(declinedRes.data ?? []), ...(reviewRes.data ?? [])] as unknown as AttentionWo[];
  for (const wo of attentionWos) {
    const reason = one(wo.work_order_internal)?.review_reason;
    if (wo.status === "rejected_by_affiliate") {
      attention.push({
        key: `wo-${wo.id}`,
        red: true,
        title: "Declined by shop",
        wo,
        detail: reason || "The shop declined this job. Choose a shop and dispatch it again.",
        at: wo.updated_at,
      });
    } else {
      attention.push({
        key: `wo-${wo.id}`,
        red: false,
        title: "Review required",
        wo,
        detail: reason || "A required routing or request field could not be validated automatically.",
        at: wo.updated_at,
      });
    }
  }
  for (const s of (shipRes.data ?? []) as unknown as ProblemShipment[]) {
    const wo = one(s.work_orders);
    if (!wo || wo.status === "cancelled") continue;
    attention.push({
      key: `ship-${s.id}`,
      red: true,
      title: "Carrier delay / exception",
      wo,
      detail: `${s.carrier ?? "Carrier"} • ${SHIPMENT_STATUS_LABEL[s.status] ?? s.status} • ${
        s.tracking_number ?? "no tracking #"
      }. Customer update may be required.`,
      at: s.updated_at,
    });
  }
  // Red (declined jobs, carrier exceptions) first, then amber; newest first in each group.
  attention.sort((a, b) => Number(b.red) - Number(a.red) || Date.parse(b.at) - Date.parse(a.at));
  const shownAttention = attention.slice(0, ATTENTION_SHOWN);

  const kpis = [
    { k: "Needs Attention", v: attention.length, sub: "CDS action or exception", href: "#attention" },
    { k: "In Progress", v: inProgress.count ?? 0, sub: "Shop / logistics moving", href: "/cds?status=in_progress#orders" },
    { k: "Ready to Invoice", v: toInvoice.count ?? 0, sub: "Work complete / billing next", href: "/cds?status=to_invoice#orders" },
    { k: `Invoiced: ${range.label}`, v: invoiced.count ?? 0, sub: "By invoice date, Pacific time", href: null },
    { k: "Pending Review", v: pendingReview.count ?? 0, sub: "Not sent to a shop yet", href: "/cds?status=pending_review#orders" },
  ];

  const loadError = listRes.error?.message ?? declinedRes.error?.message ?? reviewRes.error?.message ?? shipRes.error?.message ?? finError;
  const keepForPeriod = filterQuery(filters).replace(/^\?/, "");
  const exportHref = `/cds/export${filterQuery(filters)}`;

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Operations Dashboard</h1>
          <p>
            Routine work stays in the background. Work the exception queue; completed activity shown for {range.label}.
          </p>
        </div>
        <div style={{ display: "grid", gap: 8, width: 220 }}>
          <Link className="btn btn-primary" href="/cds?status=pending_review#orders">
            Review New Requests
          </Link>
          <Link className="btn btn-secondary" href="/cds/work-orders/new">
            Create Work Order
          </Link>
        </div>
      </div>

      <div className={styles.periodBar} style={{ marginTop: 14 }}>
        <label className="small" htmlFor="dashboard-period" style={{ fontWeight: 750 }}>
          Dashboard Period
        </label>
        <PeriodSelect id="dashboard-period" value={period} options={PERIODS} keep={keepForPeriod} />
        <span className={`pill ${styles.periodPill}`}>{range.label}</span>
        <span className="small">The period applies to the Invoiced count; everything else is current.</span>
      </div>

      {loadError && <div className="notice danger">Could not load work orders: {loadError}</div>}

      <div className="cards">
        {kpis.map((m) => {
          const body = (
            <>
              <div className="k">{m.k}</div>
              <div className="v">{m.v}</div>
              <div className="small">{m.sub}</div>
            </>
          );
          return m.href ? (
            <Link key={m.k} href={m.href} className="card metric">
              {body}
            </Link>
          ) : (
            <div key={m.k} className="card metric">
              {body}
            </div>
          );
        })}
      </div>

      <section className="section" id="attention">
        <div className="row between">
          <div>
            <h3 style={{ marginBottom: 4 }}>Needs Attention</h3>
            <p className="small" style={{ margin: 0 }}>
              Only work orders that need a CDS decision or exception handling appear here.
            </p>
          </div>
          <span className="pill">
            {attention.length} {attention.length === 1 ? "item" : "items"}
          </span>
        </div>
        {attention.length === 0 ? (
          <div className="notice">
            <b>No exceptions.</b> Routine jobs are moving through the workflow without CDS intervention.
          </div>
        ) : (
          <>
            <div className="attentionGrid">
              {shownAttention.map((a) => {
                const customer = one(a.wo.customers)?.name ?? "Unknown customer";
                const shop = one(a.wo.affiliates)?.display_name ?? "Not assigned";
                return (
                  <Link key={a.key} href={`/cds/work-orders/${a.wo.id}`} className={`attentionCard${a.red ? " red" : ""}`}>
                    <div className="eyebrow">
                      {a.title} • {woLabel(a.wo.wo_number)}
                    </div>
                    <div style={{ fontWeight: 750, margin: "6px 0" }}>
                      {customer} - {a.wo.location_label}
                    </div>
                    <div className={`small ${styles.clamp3}`} style={{ color: "#3c4850" }} title={a.detail.length > 180 ? a.detail.slice(0, 600) : undefined}>
                      {a.detail}
                    </div>
                    <div className="small" style={{ marginTop: 6 }}>
                      Affiliate: {shop} • {STATUS_LABEL[a.wo.status]}
                    </div>
                  </Link>
                );
              })}
            </div>
            {attention.length > shownAttention.length && (
              <p className="small">
                Showing {shownAttention.length} of {attention.length}, most urgent first.{" "}
                <Link className="link" href="/cds?status=attention#orders">
                  See all Pending Review and Declined orders
                </Link>
              </p>
            )}
          </>
        )}
      </section>

      <section className="section" id="orders">
        <h3>Work orders</h3>
        <Form action="/cds" className="toolbar" scroll={false}>
          <input
            className="input search"
            name="q"
            defaultValue={q}
            placeholder="Search WO, PO, unit, customer, location..."
            aria-label="Search work orders"
          />
          <select name="status" defaultValue={statusParam} style={{ maxWidth: 260 }} aria-label="Status">
            <option value="">All statuses</option>
            <optgroup label="Groups">
              {Object.entries(GROUPS).map(([value, g]) => (
                <option key={value} value={value}>
                  {g.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Status">
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </optgroup>
          </select>
          {period !== "month" && <input type="hidden" name="period" value={period} />}
          <button className="btn btn-secondary" type="submit">
            Search
          </button>
          {(q || statusParam) && (
            <Link className="link small" href={`/cds${period !== "month" ? `?period=${period}` : ""}#orders`}>
              Clear
            </Link>
          )}
          <a className="btn btn-secondary btn-small" href={exportHref} download style={{ marginLeft: "auto" }}>
            Export CSV
          </a>
        </Form>
        <div className="tablewrap">
          <table className={`wide ${styles.woTable}`}>
            <thead>
              <tr>
                <th>WO</th>
                <th>Customer</th>
                <th>Location</th>
                <th>Unit</th>
                <th>PO</th>
                <th>Affiliate</th>
                <th>Status</th>
                <th className="num">Affiliate Payable</th>
                <th className="num">Customer Subtotal</th>
                <th className="num">Gross Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="small" style={{ textAlign: "center", padding: 24 }}>
                    No work orders match.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const f = finById.get(r.id);
                  const tbd = f?.supplier_cost_tbd;
                  const customer = one(r.customers)?.name ?? "-";
                  const shop = one(r.affiliates)?.display_name ?? null;
                  const fullStatus = STATUS_LABEL[r.status] ?? r.status;
                  const shortStatus = TABLE_STATUS_LABEL[r.status] ?? fullStatus;
                  return (
                    <tr key={r.id}>
                      <td className="nowrap">
                        <Link className="link" href={`/cds/work-orders/${r.id}`}>
                          {woLabel(r.wo_number)}
                        </Link>
                      </td>
                      <td className={`${styles.textCol} ${wrapCell(customer) ?? ""}`}>{customer}</td>
                      <td className={`${styles.textCol} ${wrapCell(r.location_label) ?? ""}`}>{r.location_label}</td>
                      <td className={idClass(r.unit_number)}>{r.unit_number}</td>
                      <td className={idClass(r.po_number)}>{r.po_number ?? <span className="small">Missing</span>}</td>
                      <td className={`${styles.textCol} ${wrapCell(shop) ?? ""}`}>
                        {shop ?? <span className="small">Not assigned</span>}
                      </td>
                      <td>
                        <span className={`status ${r.status}`} title={shortStatus !== fullStatus ? fullStatus : undefined}>
                          {shortStatus}
                        </span>
                      </td>
                      <td className="num money">{tbd ? "TBD" : money(f?.shop_subtotal)}</td>
                      <td className="num money">{money(f?.customer_subtotal)}</td>
                      <td className="num money">{tbd ? "TBD" : money(f?.margin)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {rows.length === 200 && <p className="small">Showing the newest 200. Narrow the search to find older orders.</p>}
      </section>
    </>
  );
}
