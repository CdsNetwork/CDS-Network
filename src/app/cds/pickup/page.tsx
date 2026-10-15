import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { one } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { pickupWindowLabel, woLabel, type WoStatus, wrapCell } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

type PickupRow = {
  id: string;
  wo_number: number;
  market: string;
  status: WoStatus;
  location_label: string;
  site_address: string | null;
  pickup_window: string | null;
  customers: { name: string } | { name: string }[] | null;
  affiliates: { display_name: string } | { display_name: string }[] | null;
};

const OPEN: WoStatus[] = ["pending_review", "awaiting_acceptance", "accepted", "picked_up", "in_process", "completed", "rejected_by_affiliate"];

export default async function PickupPage() {
  await requireCds();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("work_orders")
    .select("id, wo_number, market, status, location_label, site_address, pickup_window, customers(name), affiliates(display_name)")
    .eq("fulfillment", "pickup")
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(300);
  const rows = (data ?? []) as PickupRow[];

  const open = rows.filter((r) => OPEN.includes(r.status));
  const committed = open.filter((r) => r.pickup_window && r.pickup_window !== "coordinate").length;
  const awaiting = open.filter(
    (r) => !r.pickup_window || r.pickup_window === "coordinate",
  ).length;

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Pickup / Local Delivery</h1>
          <p>Affiliate pickup commitments and local delivery activity.</p>
        </div>
        <span className="pill">Local logistics</span>
      </div>

      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <div className="card metric">
          <div className="k">Pickup jobs</div>
          <div className="v">{open.length}</div>
        </div>
        <div className="card metric">
          <div className="k">Pickup windows committed</div>
          <div className="v">{committed}</div>
        </div>
        <div className="card metric">
          <div className="k">Awaiting ETA</div>
          <div className="v">{awaiting}</div>
        </div>
      </div>

      {error && <div className="notice danger">Could not load pickup jobs. Refresh the page to try again.</div>}

      <div className="tablewrap">
        <table className="wide">
          <thead>
            <tr>
              <th>WO</th>
              <th>Customer</th>
              <th>Location</th>
              <th>Affiliate</th>
              <th>Pickup Address</th>
              <th>Pickup Window</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="small">
                  No pickup jobs.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">
                  <Link className="link" href={`/cds/work-orders/${r.id}`}>
                    {woLabel(r.wo_number)}
                  </Link>
                </td>
                <td>{one(r.customers)?.name ?? "-"}</td>
                <td className={wrapCell(r.location_label)}>{r.location_label}</td>
                <td>{one(r.affiliates)?.display_name ?? <span className="small">Not assigned</span>}</td>
                <td className={wrapCell(r.site_address)}>{r.site_address ?? "-"}</td>
                <td>
                  <b>{pickupWindowLabel(r.pickup_window)}</b>
                </td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="pill">{r.market}</span>
                    <StatusBadge status={r.status} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
