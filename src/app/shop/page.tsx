import Link from "next/link";
import { JobDetail } from "@/components/shop/JobDetail";
import { JobQueue } from "@/components/shop/JobQueue";
import styles from "@/components/shop/shop.module.css";
import { EDITABLE_STATUSES, tabForStatus, type QueueTab } from "@/components/shop/types";
import { requireShop } from "@/lib/auth";
import { loadJob, loadQueue } from "./data";

const TABS: QueueTab[] = ["awaiting", "active", "completed"];

export default async function ShopQueuePage({ searchParams }: PageProps<"/shop">) {
  await requireShop();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const jobId = one(params.job);
  const tabParam = one(params.tab);
  const declined = one(params.declined) === "1";

  const [queue, detail] = await Promise.all([
    loadQueue(),
    jobId ? loadJob(jobId, (j) => EDITABLE_STATUSES.includes(j.status)) : Promise.resolve(null),
  ]);

  const tab: QueueTab = TABS.includes(tabParam as QueueTab)
    ? (tabParam as QueueTab)
    : detail
      ? tabForStatus(detail.job.status)
      : queue.counts.awaiting > 0
        ? "awaiting"
        : "active";
  const showingJob = Boolean(jobId);

  return (
    <>
      <div className={`title ${showingJob ? styles.hideOnPhone : ""}`}>
        <h1>Affiliate Work Queue</h1>
        <p>Only jobs dispatched to this affiliate appear here.</p>
      </div>
      {declined && (
        <div className="notice warning" role="status">
          Job declined. It has gone back to CDS and is no longer in your queue.
        </div>
      )}
      <div className="shopGrid">
        <div className={showingJob ? styles.hideOnPhone : undefined}>
          <JobQueue tab={tab} jobs={queue.jobs[tab]} counts={queue.counts} selectedId={detail?.job.id} />
        </div>
        <div style={{ minWidth: 0 }}>
          {detail ? (
            <JobDetail data={detail} tab={tab} />
          ) : jobId ? (
            <div className="section" style={{ marginTop: 0 }}>
              <div className="notice warning">
                This job is not available. It may have been declined, reassigned or removed by CDS.
              </div>
              <Link className="link" href={`/shop?tab=${tab}`} style={{ display: "inline-flex", minHeight: 44, alignItems: "center" }}>
                Back to queue
              </Link>
            </div>
          ) : (
            <div className={`section ${styles.hideOnPhone}`} style={{ marginTop: 0 }}>
              <p className="small" style={{ margin: 0 }}>
                Select a job from the list to see its details.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
