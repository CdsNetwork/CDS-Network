import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { QboError, qboRequest, type QboApi } from "./client";
import {
  LOCATION_SYNC_SETTING_KEY,
  locationSyncEnabled,
  runLocationSync,
  type LinkedPortalCustomer,
  type LocationSyncDeps,
  type LocationSyncResult,
  type LocationSyncTrigger,
  type PortalLocationRow,
  type QboSiteRecord,
} from "./location-sync";
import { qboApi } from "./tokens";

/**
 * The IO of the location sync (rules in ./location-sync): reads the active QuickBooks
 * customers and the linked portal customers with their locations, writes through the
 * service-role-only functions of 20261119220000_qbo_location_sync.sql. Used by the hourly
 * cron and "Sync now" on Admin > Locations (after requireCds()).
 */

const PAGE = 1000;
/** Upper bound so a very large company cannot make a run hang. */
const MAX_ROWS = 20_000;

/** Every active QuickBooks customer (sub-customers included), paged (at most 1000 rows per query). Read only. */
export async function listActiveCustomers(api: QboApi): Promise<QboSiteRecord[]> {
  const rows: QboSiteRecord[] = [];
  for (let start = 1; start <= MAX_ROWS; start += PAGE) {
    const res = await qboRequest<{ QueryResponse?: { Customer?: QboSiteRecord[] } }>(api, "GET", "query", {
      query: { query: `select * from Customer where Active = true startposition ${start} maxresults ${PAGE}` },
    });
    const page = res.QueryResponse?.Customer ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function readQboCustomers(): Promise<QboSiteRecord[]> {
  const api = await qboApi();
  try {
    return await listActiveCustomers(api);
  } catch (e) {
    // An access token revoked early: refresh once and read again.
    if (e instanceof QboError && e.unauthorized) return listActiveCustomers(await qboApi({ forceRefresh: true }));
    throw e;
  }
}

/** The active portal customers linked to a QuickBooks customer, and all their locations. */
export async function loadLocationPortal(db: SupabaseClient): Promise<{ customers: LinkedPortalCustomer[]; locations: PortalLocationRow[] }> {
  type MapRow = { customer_id: string; qbo_customer_id: string; customers: { active: boolean } | { active: boolean }[] | null };
  type LocRow = { id: string; customer_id: string; code: string; location_number: string | null; name: string; city: string | null; qbo_customer_id: string | null };
  const maps = await fetchAll<MapRow>((from, to) => db.from("qbo_customer_map").select("customer_id, qbo_customer_id, customers(active)").order("id").range(from, to));
  const customers = maps
    .filter((m) => {
      const c = Array.isArray(m.customers) ? m.customers[0] : m.customers;
      return c?.active === true;
    })
    .map((m) => ({ customerId: m.customer_id, qboCustomerId: m.qbo_customer_id.trim() }));
  const ids = customers.map((c) => c.customerId);
  const locations: LocRow[] = [];
  // In chunks, so the filter stays short.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    locations.push(
      ...(await fetchAll<LocRow>((from, to) =>
        db
          .from("customer_locations")
          .select("id, customer_id, code, location_number, name, city, qbo_customer_id")
          .in("customer_id", chunk)
          .order("id")
          .range(from, to),
      )),
    );
  }
  return {
    customers,
    locations: locations.map((l) => ({
      id: l.id,
      customerId: l.customer_id,
      code: l.code,
      locationNumber: l.location_number,
      name: l.name,
      city: l.city,
      qboCustomerId: l.qbo_customer_id,
    })),
  };
}

export function locationSyncDeps(db: SupabaseClient, listQboCustomers: () => Promise<QboSiteRecord[]> = readQboCustomers): LocationSyncDeps {
  return {
    enabled: async () => {
      const { data, error } = await db.from("app_settings").select("value").eq("key", LOCATION_SYNC_SETTING_KEY).maybeSingle();
      if (error) throw new Error(`could not read the location sync setting: ${error.message}`);
      return locationSyncEnabled((data as { value: unknown } | null)?.value);
    },
    listQboCustomers,
    loadPortal: () => loadLocationPortal(db),
    createLocation: async (location) => {
      const { data, error } = await db.rpc("qbo_location_sync_create", { p_location: location });
      if (error) throw new Error(error.message);
      return data as { id: string; created: boolean; code?: string };
    },
    link: async (l) => {
      const { data, error } = await db.rpc("qbo_location_sync_link", {
        p_location: l.locationId,
        p_qbo_customer_id: l.qboCustomerId,
        p_qbo_customer_name: l.qboCustomerName,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
    recordRun: async (run) => {
      const { error } = await db.from("qbo_location_sync_runs").insert(run);
      if (error) throw new Error(`could not record the location sync run: ${error.message}`);
    },
    now: () => new Date(),
  };
}

/** One sync run with the service role. Never throws: a failure is returned (and logged). */
export async function syncLocationsFromQuickBooks(trigger: LocationSyncTrigger, options: { dryRun?: boolean } = {}): Promise<LocationSyncResult> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    return await runLocationSync(locationSyncDeps(createAdminClient()), trigger, options);
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    console.error(`QuickBooks location sync (${trigger}): ${error}`);
    return { status: "failed", created: 0, linked: 0, skipped: 0, error };
  }
}
