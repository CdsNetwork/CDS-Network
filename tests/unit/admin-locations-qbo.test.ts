/**
 * Admin > Locations for locations synced from QuickBooks (CDS 2026-11-19): the QuickBooks
 * customer of each location, "From QuickBooks, needs a default shop" on synced rows not set
 * up yet, the last sync line and "Sync now". The invoice reads the location's QuickBooks
 * customer. Source checks only (the pages need a database).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tab = readFileSync("src/app/cds/admin/LocationsTab.tsx", "utf8");
const actions = readFileSync("src/app/cds/admin/actions.ts", "utf8");
const input = readFileSync("src/lib/qbo/invoice-input.ts", "utf8");

describe("Admin > Locations", () => {
  it("reads and shows the QuickBooks customer and the needs-setup marker", () => {
    expect(tab).toMatch(/qbo_customer_name/);
    expect(tab).toMatch(/needs_setup/);
    expect(tab).toContain("From QuickBooks, needs a default shop");
  });

  it("shows that the sync is off instead of Sync now until CDS turns it on", () => {
    expect(tab).toContain("QuickBooks location sync is off until CDS turns it on.");
    expect(tab).toMatch(/LOCATION_SYNC_SETTING_KEY/);
    expect(tab).toMatch(/locationSyncEnabled\(/);
  });

  it("shows the last sync line and a Sync now button that runs the location sync", () => {
    expect(tab).toMatch(/locationSyncStatus\(/);
    expect(tab).toMatch(/qbo_location_sync_runs/);
    expect(tab).toMatch(/syncLocationsNow/);
    expect(actions).toMatch(/export async function syncLocationsNow\(/);
    expect(actions).toMatch(/syncLocationsFromQuickBooks\("manual"\)/);
  });
});

describe("invoice input", () => {
  it("reads the location's QuickBooks customer for the invoice", () => {
    expect(input).toMatch(/customer_locations\([^)]*qbo_customer_id, qbo_customer_name/);
    expect(input).toMatch(/qboCustomerId: loc\?\.qbo_customer_id/);
  });
});
