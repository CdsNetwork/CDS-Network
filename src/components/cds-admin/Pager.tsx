import Link from "next/link";
import styles from "./cds-admin.module.css";

/** Page numbers to show: the first, the last, and two on each side of the current page. */
export function pageNumbers(page: number, pages: number): (number | "gap")[] {
  const keep = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

/** Previous, page numbers and next, as links. Nothing when everything fits on one page. */
export function Pager({ page, pages, href, label }: { page: number; pages: number; href: (page: number) => string; label: string }) {
  if (pages <= 1) return null;
  return (
    <nav className={styles.pager} aria-label={label}>
      {page > 1 && (
        <Link className="btn btn-secondary btn-small" href={href(page - 1)} rel="prev">
          Previous
        </Link>
      )}
      {pageNumbers(page, pages).map((p, i) =>
        p === "gap" ? (
          <span key={`gap-${i}`} className={styles.gap} aria-hidden="true">
            ...
          </span>
        ) : (
          <Link
            key={p}
            className={`btn btn-small ${p === page ? "btn-blue" : "btn-secondary"}`}
            href={href(p)}
            aria-current={p === page ? "page" : undefined}
            aria-label={`Page ${p}`}
          >
            {p}
          </Link>
        ),
      )}
      {page < pages && (
        <Link className="btn btn-secondary btn-small" href={href(page + 1)} rel="next">
          Next
        </Link>
      )}
    </nav>
  );
}
