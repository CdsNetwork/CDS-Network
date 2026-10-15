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

/** Queue URL that keeps the search while switching tabs or opening a job. */
export function queueHref(tab: QueueTab, search: string, job?: string): string {
  const p = new URLSearchParams({ tab });
  if (search) p.set("q", search);
  if (job) p.set("job", job);
  return `/shop?${p.toString()}`;
}

export function JobQueue({
  tab,
  jobs,
  counts,
  selectedId,
  search,
}: {
  tab: QueueTab;
  jobs: QueueJob[];
  counts: Record<QueueTab, number>;
  selectedId?: string;
  search: string;
}) {
  const current = TABS.find((t) => t.key === tab)!;
  return (
    <section className="section" style={{ marginTop: 0 }}>
      <h3>Assigned work</h3>
      <form action="/shop" method="get" role="search" className={styles.queueSearch}>
        <input type="hidden" name="tab" value={tab} />
        <label htmlFor="queue-q" className={styles.srOnly}>
          Search jobs
        </label>
        <input
          className="input"
          id="queue-q"
          name="q"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          maxLength={60}
          defaultValue={search}
          placeholder="WO, unit, PO, customer, location"
        />
        <button type="submit" className="btn btn-secondary">
          Search
        </button>
      </form>
      {search && (
        <p className={`small ${styles.searchNote}`}>
          Showing jobs matching &quot;{search}&quot;.{" "}
          <Link className="link" href={queueHref(tab, "")}>
            Clear search
          </Link>
        </p>
      )}
      <nav className={styles.tabs} aria-label="Job lists">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={queueHref(t.key, search)}
            className={`${styles.tab} ${t.key === tab ? styles.tabActive : ""}`}
            aria-current={t.key === tab ? "page" : undefined}
          >
            <span className={styles.tabLabel}>{t.label}</span>
            <span className={styles.count}>{counts[t.key]}</span>
          </Link>
        ))}
      </nav>
      {jobs.length === 0 && <p className="small">{search ? "No jobs in this list match the search." : current.empty}</p>}
      {jobs.map((j) => (
        <Link
          key={j.id}
          href={queueHref(tab, search, j.id)}
          className={`job ${j.id === selectedId ? "active" : ""}`}
          aria-current={j.id === selectedId ? "true" : undefined}
        >
          <div className={`wo ${styles.nowrap}`}>{woLabel(j.wo_number)}</div>
          <div style={{ margin: "4px 0" }}>
            <strong>{j.customer_name}</strong> - {j.location_label}
          </div>
          {(j.unit_number || j.po_number) && (
            <div className="small" style={{ marginBottom: 4 }}>
              {j.unit_number && <>Unit {j.unit_number}</>}
              {j.unit_number && j.po_number && " • "}
              {j.po_number && <>PO {j.po_number}</>}
            </div>
          )}
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
