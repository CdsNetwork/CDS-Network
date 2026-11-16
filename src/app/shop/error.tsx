"use client";

// Shown when a shop page could not load its data, instead of an empty list or a total built from partial data.
export default function ShopError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ padding: "2rem 1rem", maxWidth: 520 }}>
      <h2 style={{ marginBottom: "0.5rem" }}>This page could not load</h2>
      <p style={{ marginBottom: "1rem" }}>
        Something went wrong while loading your jobs. Please try again in a moment. If it keeps happening, call CDS.
      </p>
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
