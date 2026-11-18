/**
 * Sarah, CDS, 2026-11-18: "We don't have 'Reconditioned Decomp' in the 'Priced on this order'
 * drop down". The QuickBooks catalog sync created it (SKU CDS-DECOMP-RECON5418127, RECON
 * DECOMP) as a plain part, while the drop down lists items priced per line and not pass
 * through (like CDS-RECON-DPF). A data migration gives it those flags; new synced items stay
 * plain (tests/unit/qbo-catalog-sync.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(__dirname, "../../supabase/migrations/20261119110000_recon_decomp_priced_on_order.sql"), "utf8");
const page = readFileSync(join(__dirname, "../../src/app/cds/work-orders/[id]/page.tsx"), "utf8");
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, "").trim())
  .filter(Boolean)
  .join(" ");

describe("RECON DECOMP in Priced on this order", () => {
  it("the drop down lists items priced per line that are not pass through", () => {
    expect(page).toMatch(/const pricedItems = catalog\.filter\(\(c\) => c\.price_per_line && !c\.pass_through\);/);
  });

  it("the migration sets those flags on that one SKU only, and only when they differ", () => {
    expect(code).toMatch(
      /^update public\.catalog_items set price_per_line = true, pass_through = false where sku = 'CDS-DECOMP-RECON5418127' and \(not price_per_line or pass_through\);$/,
    );
  });
});
