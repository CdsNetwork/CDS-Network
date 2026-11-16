"use client";

import Link from "next/link";

// Shown inside the CDS layout when a CDS page could not load, so staff keep the menu and a way back.
// The raw error text is not shown; the reference lets us find it in the logs.
export default function CdsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="section" style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>This page could not load</h2>
      <div className="notice danger">Try again. If it keeps happening, tell Samed the time it happened and what you clicked.</div>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
        <Link className="btn btn-secondary" href="/cds">
          Back to the dashboard
        </Link>
      </div>
      {error.digest && (
        <p className="small" style={{ marginTop: 12 }}>
          Reference: {error.digest}
        </p>
      )}
    </div>
  );
}
