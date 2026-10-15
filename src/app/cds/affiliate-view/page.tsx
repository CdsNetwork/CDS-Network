import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import type { SearchOption } from "@/components/SearchSelect";
import styles from "@/components/cds-wo/cds-wo.module.css";
import { isUuid, one } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { woLabel, type WoStatus } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { loadPreview, ShopPreview } from "./ShopPreview";
import { ShopPicker } from "./ShopPicker";

/** Statuses a shop never sees (RLS: private.shop_can_see_wo). */
const HIDDEN = "(pending_review,rejected_by_affiliate)";
const AWAITING: WoStatus[] = ["awaiting_acceptance"];
const ACTIVE: WoStatus[] = ["accepted", "picked_up", "in_process"];

type ShopRow = { id: string; display_name: string; kind: string; city: string | null; region: string | null; active: boolean };
type JobRow = {
  id: string;
  wo_number: number;
  status: WoStatus;
  location_label: string;
  requested_work: string;
  customers: { name: string } | { name: string }[] | null;
};

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Dispatched job counts per shop (all and active), read in pages of 1000. */
async function loadJobCounts(supabase: Supabase) {
  const all = new Map<string, number>();
  const active = new Map<string, number>();
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await supabase
      .from("work_orders")
      .select("id, affiliate_id, status")
      .not("affiliate_id", "is", null)
      .not("status", "in", HIDDEN)
      .order("id")
      .range(from, from + 999);
    if (error || !data) break;
    for (const r of data as { affiliate_id: string; status: WoStatus }[]) {
      all.set(r.affiliate_id, (all.get(r.affiliate_id) ?? 0) + 1);
      if (AWAITING.includes(r.status) || ACTIVE.includes(r.status)) {
        active.set(r.affiliate_id, (active.get(r.affiliate_id) ?? 0) + 1);
      }
    }
    if (data.length < 1000) break;
  }
  return { all, active };
}

export default async function AffiliateViewPage({ searchParams }: PageProps<"/cds/affiliate-view">) {
  await requireCds();
  const sp = await searchParams;
  const shopId = typeof sp.shop === "string" && isUuid(sp.shop) ? sp.shop : "";
  const woId = typeof sp.wo === "string" && isUuid(sp.wo) ? sp.wo : "";

  const supabase = await createClient();
  const [shopsRes, counts] = await Promise.all([
    supabase.from("affiliates").select("id, display_name, kind, city, region, active").order("display_name"),
    loadJobCounts(supabase),
  ]);
  const shops = (shopsRes.data ?? []) as ShopRow[];
  const shop = shops.find((s) => s.id === shopId) ?? null;

  // Shops with active jobs first (most first), then by name.
  const options: SearchOption[] = [...shops]
    .sort(
      (a, b) =>
        (counts.active.get(b.id) ?? 0) - (counts.active.get(a.id) ?? 0) ||
        (counts.all.get(b.id) ?? 0) - (counts.all.get(a.id) ?? 0) ||
        a.display_name.localeCompare(b.display_name),
    )
    .map((s) => {
      const n = counts.active.get(s.id) ?? 0;
      const total = counts.all.get(s.id) ?? 0;
      const place = [s.city, s.region].filter(Boolean).join(", ") || "No city";
      const marks = [s.kind === "parts_supplier" ? "(parts supplier)" : "", s.active ? "" : "(inactive)"].filter(Boolean);
      return {
        value: s.id,
        label: [s.display_name, ...marks].join(" "),
        hint: `${n} active ${n === 1 ? "job" : "jobs"} - ${total} visible - ${place}`,
      };
    });

  // The shop's job list: exactly the orders its queue can show.
  let jobs: JobRow[] = [];
  let jobsError: string | null = null;
  if (shop) {
    const { data, error } = await supabase
      .from("work_orders")
      .select("id, wo_number, status, location_label, requested_work, customers(name)")
      .eq("affiliate_id", shop.id)
      .not("status", "in", HIDDEN)
      .order("wo_number", { ascending: false })
      .limit(300);
    jobs = (data ?? []) as unknown as JobRow[];
    jobsError = error?.message ?? null;
  }
  const metric = (statuses: WoStatus[]) => jobs.filter((j) => statuses.includes(j.status)).length;

  // The selected job, only when this shop can see it.
  let preview = null;
  let hiddenNotice: string | null = null;
  if (shop && woId) {
    preview = await loadPreview(supabase, shop.id, woId);
    if (!preview) {
      const { data } = await supabase.from("work_orders").select("status, affiliate_id").eq("id", woId).maybeSingle();
      const w = data as { status: WoStatus; affiliate_id: string | null } | null;
      hiddenNotice =
        w && w.affiliate_id === shop.id && (w.status === "pending_review" || w.status === "rejected_by_affiliate")
          ? "This work order has not been dispatched to the affiliate yet. Review and dispatch it first."
          : "This shop cannot see that work order.";
    }
  }

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Affiliate View</h1>
          <p>
            CDS preview of the shop portal. Select a shop, then a work order, to see exactly what that shop sees. Shops
            with active jobs are listed first.
          </p>
        </div>
      </div>

      <section className="section">
        <div className={styles.pickerBar}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="preview-shop">Preview shop</label>
            <ShopPicker options={options} value={shop?.id ?? ""} />
          </div>
          <p className="small" style={{ margin: 0 }}>
            Every shop is searchable, including shops with no jobs, so routing can be checked before dispatch. Pending
            Review and declined orders never appear: shops cannot see them.
          </p>
        </div>
        {shopsRes.error && <div className="notice danger">Could not load shops: {shopsRes.error.message}</div>}
      </section>

      {shop && (
        <>
          <div className={styles.previewBanner} role="note">
            Preview: this is what {shop.display_name} sees. Read only.
          </div>

          <div className="grid4">
            <div className="miniMetric">
              <div className="l">Visible Jobs</div>
              <div className="n">{jobs.length}</div>
            </div>
            <div className="miniMetric">
              <div className="l">Awaiting Acceptance</div>
              <div className="n">{metric(AWAITING)}</div>
            </div>
            <div className="miniMetric">
              <div className="l">In Progress</div>
              <div className="n">{metric(ACTIVE)}</div>
            </div>
            <div className="miniMetric">
              <div className="l">Completed</div>
              <div className="n">{metric(["completed", "delivered", "ready_to_invoice", "invoiced"])}</div>
            </div>
          </div>

          {jobsError && <div className="notice danger">Could not load work orders: {jobsError}</div>}

          <div className="shopGrid">
            <section className="section" style={{ marginTop: 0 }}>
              <h3>Assigned work</h3>
              {jobs.length === 0 ? (
                <div className="notice">
                  <b>No dispatched work orders for this shop.</b> Select another shop.
                </div>
              ) : (
                <div className={styles.jobList}>
                  {jobs.map((j) => (
                    <Link
                      key={j.id}
                      href={`/cds/affiliate-view?shop=${shop.id}&wo=${j.id}`}
                      className={`job${j.id === woId ? " active" : ""}`}
                      scroll={false}
                    >
                      <div className="wo">{woLabel(j.wo_number)}</div>
                      <div>
                        <b>{one(j.customers)?.name ?? ""}</b> - {j.location_label}
                      </div>
                      <div className={`small ${styles.clamp3}`}>{j.requested_work}</div>
                      <div style={{ marginTop: 6 }}>
                        <StatusBadge status={j.status} shop />
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </section>
            <div style={{ minWidth: 0 }}>
              {preview ? (
                <ShopPreview data={preview} />
              ) : hiddenNotice ? (
                <div className="section" style={{ marginTop: 0 }}>
                  <div className="notice warning">{hiddenNotice}</div>
                </div>
              ) : (
                <div className="section" style={{ marginTop: 0 }}>
                  <p className="small" style={{ margin: 0 }}>
                    Select a work order from the list to preview the shop&apos;s job screen.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
