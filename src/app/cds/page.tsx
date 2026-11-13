import Form from "next/form";
import Link from "next/link";
import { PeriodSelect } from "@/components/cds-wo/PeriodSelect";
import { isQuestionPending, QUESTION_PARAM, questionTitle } from "@/components/cds-wo/question-pending";
import { failedMark, isNewFromShop } from "@/components/cds-wo/shop-updates";
import styles from "@/components/cds-wo/cds-wo.module.css";
import { one } from "@/components/cds-wo/util";
import {
  ALL_STATUSES,
  CONDEMNED,
  filteredWorkOrders,
  filterQuery,
  financialsFor,
  GROUPS,
  IN_HOUSE,
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
import { deletedMessage } from "@/lib/work-order-delete";
import { internalStatusLabel } from "@/lib/internal-status";
import {
  dateReceived,
  FULFILLMENT_LABEL,
  logisticsLabel,
  money,
  STATUS_LABEL,
  woLabel,
  type WoStatus,
  wrapCell,
} from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

type Named = { name: string } | null;
/** is_in_house: CDS's own shop, whose total is CDS cost rather than an affiliate payable. */
type Shop = { display_name: string; is_in_house?: boolean } | null;

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

type ListInternal = {
  inbound_emails: { received_at: string | null } | { received_at: string | null }[] | null;
  internal_status: string | null;
  qb_invoice_number?: string | null;
};

type ListRow = WoRow & {
  created_at: string;
  fulfillment: string;
  work_order_internal: ListInternal | ListInternal[] | null;
  work_order_shop_activity: { is_new: boolean | null } | { is_new: boolean | null }[] | null;
  work_order_components: { result: string | null }[] | null;
  work_order_questions: { question_pending: boolean | null; note: string | null } | { question_pending: boolean | null; note: string | null }[] | null;
};

const WO_COLUMNS =
  "id, wo_number, status, location_label, unit_number, po_number, customers(name), affiliates(display_name, is_in_house)";

/**
 * The table also shows when the request came in, how the part moves, whether the shop did
 * something CDS has not opened yet, a failed or condemned component, a pending customer
 * question, and CDS's own internal status.
 */
const LIST_COLUMNS = `${WO_COLUMNS}, created_at, fulfillment, work_order_internal(inbound_emails(received_at), internal_status, qb_invoice_number), work_order_shop_activity(is_new), work_order_components(result), work_order_questions(question_pending, note)`;

/** Unit and PO numbers up to this length stay on one line in the table. */
const ID_NOWRAP = 22;

function idClass(value: string | null): string {
  return (value ?? "").length > ID_NOWRAP ? styles.idCol : styles.idShort;
}

export default async function DashboardPage({ searchParams }: PageProps<"/cds">) {
  await requireCds();
  const sp = await searchParams;
  const deleted = deletedMessage(sp);
  const filters = parseFilters(sp);
  const { q, status: statusParam, shop: shopParam, fromShop, question } = filters;
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

  // Work order table query (same filters and order as the CSV export): most pressing status
  // first, newest first within a status.
  const list = (await filteredWorkOrders(supabase, filters, LIST_COLUMNS)).query.limit(200);

  const [listRes, inProgress, toInvoice, pendingReview, invoiced, shopsRes] = await Promise.all([
    list,
    countOf(IN_PROGRESS),
    countOf(TO_INVOICE),
    countOf(["pending_review"]),
    invoicedQuery,
    // Shop filter of the table: CDS's in-house shop first, then active shops by name.
    supabase.from("affiliates").select("id, display_name, is_in_house, active").order("display_name"),
  ]);
  const shopChoices = ((shopsRes.data ?? []) as { id: string; display_name: string; is_in_house: boolean; active: boolean }[])
    .filter((s) => !s.is_in_house && (s.active || s.id === shopParam))
    .map((s) => ({ id: s.id, label: s.active ? s.display_name : `${s.display_name} (inactive)` }));

  const rows = (listRes.data ?? []) as unknown as ListRow[];

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

  const kpis = [
    { k: "In Progress", v: inProgress.count ?? 0, sub: "Shop / logistics moving", href: "/cds?status=in_progress#orders" },
    { k: "Ready to Invoice", v: toInvoice.count ?? 0, sub: "Work complete / billing next", href: "/cds?status=to_invoice#orders" },
    { k: `Invoiced: ${range.label}`, v: invoiced.count ?? 0, sub: "By invoice date, Pacific time", href: null },
    { k: "Pending Review", v: pendingReview.count ?? 0, sub: "Not sent to a shop yet", href: "/cds?status=pending_review#orders" },
  ];

  const loadError = listRes.error?.message ?? finError;
  const keepForPeriod = filterQuery(filters).replace(/^\?/, "");
  const exportHref = `/cds/export${filterQuery(filters)}`;

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Operations Dashboard</h1>
          <p>
            Most pressing orders first in the table below; completed activity shown for {range.label}.
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

      {deleted && (
        <div className="notice" role="status">
          {deleted.text}
        </div>
      )}
      {loadError && <div className="notice danger">Could not load work orders: {loadError}</div>}

      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
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

      <section className="section" id="orders">
        <h3>Work orders</h3>
        <Form action="/cds" className="toolbar" scroll={false}>
          <input
            className="input search"
            name="q"
            defaultValue={q}
            placeholder="Search WO, PO, unit, customer, location, tracking #..."
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
            <optgroup label="Component result">
              <option value={CONDEMNED}>Condemned</option>
            </optgroup>
          </select>
          <select name="shop" defaultValue={shopParam} style={{ maxWidth: 240 }} aria-label="Shop">
            <option value="">All shops</option>
            <option value={IN_HOUSE}>In-house sales (CDS Inc)</option>
            {shopChoices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <label className="small nowrap" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" name="from_shop" value="1" defaultChecked={fromShop} />
            New from shop
          </label>
          <label className="small nowrap" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" name={QUESTION_PARAM} value="1" defaultChecked={question} />
            Question Pending
          </label>
          {period !== "month" && <input type="hidden" name="period" value={period} />}
          <button className="btn btn-secondary" type="submit">
            Search
          </button>
          {shopParam !== IN_HOUSE && (
            <Link className="link small" href={`/cds?shop=${IN_HOUSE}${period !== "month" ? `&period=${period}` : ""}#orders`}>
              In-house sales
            </Link>
          )}
          {(q || statusParam || shopParam || fromShop || question) && (
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
                <th>Date received</th>
                <th>Customer</th>
                <th>Location</th>
                <th>Unit</th>
                <th>PO</th>
                <th>Affiliate</th>
                <th>Logistics</th>
                <th>Status</th>
                <th className="num">Affiliate Payable</th>
                <th className="num">Customer Subtotal</th>
                <th className="num">Gross Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="small" style={{ textAlign: "center", padding: 24 }}>
                    No work orders match.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const f = finById.get(r.id);
                  const tbd = f?.supplier_cost_tbd;
                  const customer = one(r.customers)?.name ?? "-";
                  const shop = one(r.affiliates)?.display_name ?? null;
                  const inHouse = Boolean(one(r.affiliates)?.is_in_house);
                  const fullStatus = STATUS_LABEL[r.status] ?? r.status;
                  const shortStatus = TABLE_STATUS_LABEL[r.status] ?? fullStatus;
                  const fromShopNew = isNewFromShop(r.work_order_shop_activity);
                  const failed = failedMark(r.work_order_components);
                  const questionOpen = isQuestionPending(r.work_order_questions);
                  const internalStatus = internalStatusLabel(one(r.work_order_internal)?.internal_status);
                  // Invoiced in QuickBooks before the shop finished: the status moves to Invoiced when the shop completes.
                  const invoicedEarly = r.status !== "invoiced" ? one(r.work_order_internal)?.qb_invoice_number ?? null : null;
                  return (
                    <tr key={r.id} className={questionOpen ? styles.questionRow : undefined}>
                      <td className="nowrap">
                        <Link className="link" href={`/cds/work-orders/${r.id}`}>
                          {woLabel(r.wo_number)}
                        </Link>
                        {fromShopNew && (
                          <div>
                            <span className="badge pending" title="The shop added a note, a file or a condemned part since CDS last opened this order">
                              New from shop
                            </span>
                          </div>
                        )}
                        {questionOpen && (
                          <div>
                            <span className={styles.questionBadge} title={questionTitle(r.work_order_questions) ?? undefined}>
                              Question Pending
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="nowrap">{dateReceived(r)}</td>
                      <td className={`${styles.textCol} ${wrapCell(customer) ?? ""}`}>{customer}</td>
                      <td className={`${styles.textCol} ${wrapCell(r.location_label) ?? ""}`}>{r.location_label}</td>
                      <td className={idClass(r.unit_number)}>{r.unit_number}</td>
                      <td className={idClass(r.po_number)}>{r.po_number ?? <span className="small">Missing</span>}</td>
                      <td className={`${styles.textCol} ${wrapCell(shop) ?? ""}`}>
                        {shop ?? <span className="small">Not assigned</span>}
                      </td>
                      <td className="nowrap" title={FULFILLMENT_LABEL[r.fulfillment]}>
                        {logisticsLabel(r.fulfillment)}
                      </td>
                      <td>
                        <span className={`status ${r.status}`} title={shortStatus !== fullStatus ? fullStatus : undefined}>
                          {shortStatus}
                        </span>
                        {failed && (
                          <div>
                            <span className="badge rejected">{failed}</span>
                          </div>
                        )}
                        {invoicedEarly && (
                          <div>
                            <span className="badge internal" title="Invoiced in QuickBooks; moves to Invoiced when the shop completes the job">
                              Invoiced {invoicedEarly}
                            </span>
                          </div>
                        )}
                        {internalStatus && (
                          <div>
                            <span className="badge internal" title="Internal status (CDS only)">
                              {internalStatus}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="num money">
                        {tbd ? "TBD" : money(f?.shop_subtotal)}
                        {inHouse && <div className="small">CDS cost</div>}
                      </td>
                      <td className="num money">{money(f?.customer_subtotal)}</td>
                      <td className="num money">{tbd ? "TBD" : money(f?.margin)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {rows.length === 200 && <p className="small">Showing the first 200, most pressing first. Narrow the search to find the others.</p>}
      </section>
    </>
  );
}
