import { one } from "@/components/cds-wo/util";
import { filteredWorkOrders, financialsFor, parseFilters } from "@/components/cds-wo/woFilters";
import { requireCds } from "@/lib/auth";
import { date, dateTime, STATUS_LABEL, woLabel, type WoStatus } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

/** Upper bound for one export; the dashboard itself shows the newest 200. */
const MAX_ROWS = 10000;
const PAGE = 1000;

type Row = {
  id: string;
  wo_number: number;
  status: WoStatus;
  created_at: string;
  location_label: string;
  unit_number: string;
  po_number: string | null;
  customers: { name: string } | { name: string }[] | null;
  affiliates: { display_name: string } | { display_name: string }[] | null;
};

/** One CSV field: quoted when needed; text that a spreadsheet would run as a formula is prefixed. */
function field(value: string | number | null | undefined, text = true): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function amount(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : Number(v).toFixed(2);
}

/** CSV of the dashboard work order table with the same filters (q, status). CDS staff only. */
export async function GET(request: Request) {
  await requireCds();
  const filters = parseFilters(new URL(request.url).searchParams);
  const supabase = await createClient();

  const columns =
    "id, wo_number, status, created_at, location_label, unit_number, po_number, customers(name), affiliates(display_name)";
  const rows: Row[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { query } = await filteredWorkOrders(supabase, filters, columns);
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) return new Response(`Could not export work orders: ${error.message}`, { status: 500 });
    rows.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < PAGE) break;
  }

  let fin;
  try {
    fin = await financialsFor(
      supabase,
      rows.map((r) => r.id),
    );
  } catch (e) {
    return new Response(`Could not export work orders: ${e instanceof Error ? e.message : "unknown error"}`, {
      status: 500,
    });
  }

  const header = [
    "WO",
    "Created (PT)",
    "Customer",
    "Location",
    "Unit",
    "PO",
    "Shop",
    "Status",
    "Shop Payable",
    "Customer Subtotal",
    "Margin",
  ];
  const lines = [header.map((h) => field(h)).join(",")];
  for (const r of rows) {
    const f = fin.get(r.id);
    const tbd = f?.supplier_cost_tbd ?? false;
    lines.push(
      [
        field(woLabel(r.wo_number)),
        field(dateTime(r.created_at).replace(/ PT$/, "")),
        field(one(r.customers)?.name),
        field(r.location_label),
        field(r.unit_number),
        field(r.po_number),
        field(one(r.affiliates)?.display_name),
        field(STATUS_LABEL[r.status] ?? r.status),
        tbd ? "TBD" : field(amount(f?.shop_subtotal), false),
        field(amount(f?.customer_subtotal), false),
        tbd ? "TBD" : field(amount(f?.margin), false),
      ].join(","),
    );
  }

  const filename = `work-orders-${date(new Date().toISOString())}.csv`;
  // Byte order mark so Excel reads the file as UTF-8.
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
