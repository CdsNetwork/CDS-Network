import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { woLabel } from "@/lib/format";
import styles from "./shop.module.css";
import type { QueueJob, QueueTab } from "./types";

const TABS: { key: QueueTab; label: string; empty: string }[] = [
  { key: "awaiting", label: "Awaiting", empty: "No jobs waiting for your acceptance." },
  { key: "active", label: "Active", empty: "No active jobs." },
  { key: "completed", label: "Completed", empty: "No completed jobs yet." },
];

export function JobQueue({
  tab,
  jobs,
  counts,
  selectedId,
}: {
  tab: QueueTab;
  jobs: QueueJob[];
  counts: Record<QueueTab, number>;
  selectedId?: string;
}) {
  const current = TABS.find((t) => t.key === tab)!;
  return (
    <section className="section" style={{ marginTop: 0 }}>
      <h3>Assigned work</h3>
      <nav className={styles.tabs} aria-label="Job lists">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/shop?tab=${t.key}`}
            className={`${styles.tab} ${t.key === tab ? styles.tabActive : ""}`}
            aria-current={t.key === tab ? "page" : undefined}
          >
            {t.label} <span className={styles.count}>{counts[t.key]}</span>
          </Link>
        ))}
      </nav>
      {jobs.length === 0 && <p className="small">{current.empty}</p>}
      {jobs.map((j) => (
        <Link
          key={j.id}
          href={`/shop?tab=${tab}&job=${j.id}`}
          className={`job ${j.id === selectedId ? "active" : ""}`}
          aria-current={j.id === selectedId ? "true" : undefined}
        >
          <div className="wo">{woLabel(j.wo_number)}</div>
          <div style={{ margin: "4px 0" }}>
            <strong>{j.customer_name}</strong> - {j.location_label}
          </div>
          <div className="small" style={{ marginBottom: 8 }}>
            {j.requested_work}
          </div>
          <StatusBadge status={j.status} shop />
        </Link>
      ))}
      {tab === "completed" && counts.completed > jobs.length && (
        <p className="small">Showing the latest {jobs.length} completed jobs.</p>
      )}
    </section>
  );
}
