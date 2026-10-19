import Link from "next/link";
import { NewWorkOrderForm, type CatalogOption, type LocationOption } from "@/components/cds-wo/NewWorkOrderForm";
import { requireCds } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createWorkOrder } from "./actions";
import { pacificToday } from "@/lib/dates";
import { fetchAllSettled } from "@/lib/supabase/fetch-all";
import { loadPickerLocations } from "./locations";

type PriceRow = { catalog_item_id: string; amount: number; effective_from: string };
type OverrideRow = PriceRow & { customer_id: string };

/** Keeps the newest row per key (rows must be sorted by effective_from descending). */
function newest<T extends { effective_from: string }>(rows: T[], key: (r: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) if (!out.has(key(r))) out.set(key(r), r);
  return out;
}

export default async function NewWorkOrderPage() {
  await requireCds();
  const supabase = await createClient();
  const today = pacificToday();
  const current = `effective_to.is.null,effective_to.gt.${today}`;

  const [customersRes, locationsRes, catalogRes, sellRes, overrideRes] = await Promise.all([
    supabase.from("customers").select("id, code, name").eq("active", true).order("name"),
    loadPickerLocations(supabase),
    supabase.from("catalog_items").select("id, sku, name, category, oe_cross").eq("active", true).order("category").order("sku"),
    supabase
      .from("sell_prices")
      .select("catalog_item_id, amount, effective_from")
      .eq("market", "US")
      .lte("effective_from", today)
      .or(current)
      .order("effective_from", { ascending: false }),
    // One row per customer and item in effect today: grows with customers times items, so paged.
    fetchAllSettled<OverrideRow>((from, to) =>
      supabase
        .from("customer_price_overrides")
        .select("customer_id, catalog_item_id, amount, effective_from")
        .eq("market", "US")
        .lte("effective_from", today)
        .or(current)
        .order("effective_from", { ascending: false })
        .order("id")
        .range(from, to),
    ),
  ]);

  const fleet = newest((sellRes.data ?? []) as PriceRow[], (r) => r.catalog_item_id);
  const overrides: Record<string, Record<string, number>> = {};
  for (const [, r] of newest((overrideRes.data ?? []) as OverrideRow[], (r) => `${r.customer_id}:${r.catalog_item_id}`)) {
    (overrides[r.customer_id] ??= {})[r.catalog_item_id] = Number(r.amount);
  }

  const catalog: CatalogOption[] = (
    (catalogRes.data ?? []) as { id: string; sku: string; name: string; category: string; oe_cross: string | null }[]
  ).map((c) => ({ ...c, fleetPrice: fleet.has(c.id) ? Number(fleet.get(c.id)!.amount) : null }));

  const locations: LocationOption[] = locationsRes.data ?? [];

  const loadError = customersRes.error ?? locationsRes.error ?? catalogRes.error ?? sellRes.error ?? overrideRes.error;

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Create Work Order</h1>
          <p>Customer pricing comes from the CDS price list. The shop never sees customer prices.</p>
        </div>
        <Link className="btn btn-secondary" href="/cds">
          Back
        </Link>
      </div>
      {loadError && <div className="notice danger">Could not load form data: {loadError.message}</div>}
      <div className="notice warning">
        New work orders land in <b>Pending Review</b>. CDS reviews every order and dispatches it to a shop from the
        work order page.
      </div>
      <NewWorkOrderForm
        action={createWorkOrder}
        customers={(customersRes.data ?? []) as { id: string; code: string; name: string }[]}
        locations={locations}
        catalog={catalog}
        overrides={overrides}
      />
    </>
  );
}
