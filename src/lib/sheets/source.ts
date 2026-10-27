/**
 * Reads work orders for the Sheets backup with the service role client (the cron has no
 * login; the backup is CDS's own copy, so CDS-only columns are read too).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { WoStatus } from "@/lib/format";
import type { BackupOrder } from "./columns";
import { rowsFromNote, runRow, type BackupRun, type LastRuns } from "./sync";

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const latest = (...values: (string | null | undefined)[]) =>
  values.filter((v): v is string => !!v).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));

const COLUMNS = `
  id, wo_number, created_at, updated_at, status, location_label, unit_number, po_number, vin, mileage, requested_work,
  dispatched_at, picked_up_at, completed_at, delivered_at, affiliate_invoice_ref,
  customers(name), customer_locations(code), affiliates(display_name),
  work_order_internal(location_code_raw, supplier_cost_tbd, qb_invoice_number, invoiced_at),
  work_order_lines(qty, shop_unit_rate, created_at, catalog_items(sku, name), work_order_line_pricing(customer_unit_price)),
  work_order_components(seq, component_type, manufacturer, part_number, weight_removed_g, result, result_note, updated_at),
  shipments(created_at, carrier, tracking_number, status, updated_at, shipment_internal(actual_cost, quoted_cost))`;

type Row = {
  id: string;
  wo_number: number;
  created_at: string;
  updated_at: string;
  status: WoStatus;
  location_label: string;
  unit_number: string | null;
  po_number: string | null;
  vin: string | null;
  mileage: number | null;
  requested_work: string;
  dispatched_at: string | null;
  picked_up_at: string | null;
  completed_at: string | null;
  delivered_at: string | null;
  affiliate_invoice_ref: string | null;
  customers: { name: string } | null;
  customer_locations: { code: string } | null;
  affiliates: { display_name: string } | null;
  work_order_internal:
    | { location_code_raw: string | null; supplier_cost_tbd: boolean; qb_invoice_number: string | null; invoiced_at: string | null }
    | null;
  work_order_lines: {
    qty: number;
    shop_unit_rate: number | null;
    created_at: string;
    catalog_items: { sku: string; name: string } | null;
    work_order_line_pricing: { customer_unit_price: number } | null;
  }[];
  work_order_components: {
    seq: number;
    component_type: string;
    manufacturer: string | null;
    part_number: string | null;
    weight_removed_g: number | null;
    result: string | null;
    result_note: string | null;
    updated_at: string;
  }[];
  shipments: {
    created_at: string;
    carrier: string | null;
    tracking_number: string | null;
    status: string;
    updated_at: string;
    shipment_internal: { actual_cost: number | null; quoted_cost: number | null } | null;
  }[];
};

export function toBackupOrder(r: Row): BackupOrder {
  const internal = one(r.work_order_internal);
  return {
    woNumber: Number(r.wo_number),
    createdAt: r.created_at,
    status: r.status,
    customer: one(r.customers)?.name ?? null,
    locationCode: one(r.customer_locations)?.code ?? internal?.location_code_raw ?? null,
    location: r.location_label,
    shop: one(r.affiliates)?.display_name ?? null,
    unitNumber: r.unit_number,
    poNumber: r.po_number,
    vin: r.vin,
    mileage: num(r.mileage),
    requestedWork: r.requested_work,
    dispatchedAt: r.dispatched_at,
    pickedUpAt: r.picked_up_at,
    completedAt: r.completed_at,
    deliveredAt: r.delivered_at,
    shopInvoiceRef: r.affiliate_invoice_ref,
    supplierCostTbd: internal?.supplier_cost_tbd ?? false,
    invoiceNumber: internal?.qb_invoice_number ?? null,
    invoicedAt: internal?.invoiced_at ?? null,
    updatedAt: latest(
      r.updated_at,
      ...r.work_order_lines.map((l) => l.created_at),
      ...r.work_order_components.map((c) => c.updated_at),
      ...r.shipments.map((s) => s.updated_at),
    ),
    lines: r.work_order_lines.map((l) => {
      const item = one(l.catalog_items);
      return {
        sku: item?.sku ?? "",
        name: item?.name ?? "",
        qty: Number(l.qty),
        shopUnitRate: num(l.shop_unit_rate),
        customerUnitPrice: num(one(l.work_order_line_pricing)?.customer_unit_price),
      };
    }),
    components: [...r.work_order_components]
      .sort((a, b) => a.seq - b.seq)
      .map((c) => ({
        type: c.component_type,
        manufacturer: c.manufacturer,
        partNumber: c.part_number,
        weightRemovedG: num(c.weight_removed_g),
        result: c.result,
        resultNote: c.result_note,
      })),
    shipments: [...r.shipments]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((s) => {
        const cost = one(s.shipment_internal);
        return { carrier: s.carrier, trackingNumber: s.tracking_number, status: s.status, cost: num(cost?.actual_cost ?? cost?.quoted_cost) };
      }),
  };
}

const IN_CHUNK = 200;

/** Ids of work orders with a change at or after `since` (the order or anything under it). */
async function changedIds(db: SupabaseClient, since: string): Promise<string[]> {
  const ids = new Set<string>();
  const sources: [string, string, string][] = [
    ["work_orders", "id", "updated_at"],
    ["work_orders", "id", "created_at"],
    ["work_order_events", "work_order_id", "at"],
    ["work_order_lines", "work_order_id", "created_at"],
    ["work_order_components", "work_order_id", "updated_at"],
    ["shipments", "work_order_id", "updated_at"],
  ];
  for (const [table, idCol, tsCol] of sources) {
    const rows = await fetchAll<Record<string, string>>((from, to) =>
      db.from(table).select(`${idCol}, ${tsCol}`).gte(tsCol, since).order(tsCol).order(idCol).range(from, to) as never,
    );
    for (const r of rows) ids.add(r[idCol]);
  }
  return [...ids];
}

export async function loadBackupOrders(db: SupabaseClient, since: string | null): Promise<BackupOrder[]> {
  let rows: Row[] = [];
  if (since === null) {
    rows = await fetchAll<Row>((from, to) => db.from("work_orders").select(COLUMNS).order("wo_number").range(from, to) as never);
  } else {
    const ids = await changedIds(db, since);
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { data, error } = await db.from("work_orders").select(COLUMNS).in("id", ids.slice(i, i + IN_CHUNK));
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as unknown as Row[]));
    }
  }
  return rows.map(toBackupOrder);
}

/** Watermark and last full run, from the integration_sync rows of earlier successful runs. */
export async function lastBackupRuns(db: SupabaseClient): Promise<LastRuns> {
  const pick = async (entities: string[]) => {
    const { data, error } = await db
      .from("integration_sync")
      .select("external_id, at")
      .eq("system", "sheets")
      .eq("status", "ok")
      .in("entity", entities)
      .order("at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`could not read the last backup: ${error.message}`);
    return data as { external_id: string | null; at: string } | null;
  };
  const lastOk = await pick(["backup", "backup_full"]);
  const lastFull = await pick(["backup_full"]);
  return { watermark: lastOk?.external_id ?? null, lastFullAt: lastFull?.external_id ?? null };
}

export async function recordBackupRun(db: SupabaseClient, run: BackupRun): Promise<void> {
  const { error } = await db.from("integration_sync").insert(runRow(run));
  if (error) throw new Error(`could not record the backup run: ${error.message}`);
}

export type BackupStatus = {
  configured: boolean;
  lastOkAt: string | null;
  rows: number | null;
  /** The latest run failed: its time and message. */
  lastError: { at: string; message: string } | null;
};

/** What Admin > Settings shows: the last successful run, and the latest run when it failed. */
export async function backupStatus(db: SupabaseClient, configured: boolean): Promise<BackupStatus> {
  const { data, error } = await db
    .from("integration_sync")
    .select("status, error, at")
    .eq("system", "sheets")
    .in("entity", ["backup", "backup_full"])
    .order("at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  const runs = (data ?? []) as { status: string; error: string | null; at: string }[];
  const ok = runs.find((r) => r.status === "ok") ?? null;
  const latestRun = runs[0];
  return {
    configured,
    lastOkAt: ok?.at ?? null,
    rows: ok ? rowsFromNote(ok.error) : null,
    lastError: latestRun && latestRun.status !== "ok" ? { at: latestRun.at, message: latestRun.error ?? "unknown error" } : null,
  };
}
