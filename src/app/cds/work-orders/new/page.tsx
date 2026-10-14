import Link from "next/link";
import { NewWorkOrderForm, type CatalogOption, type LocationOption } from "@/components/cds-wo/NewWorkOrderForm";
import { one } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createWorkOrder } from "./actions";

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
  const today = new Date().toISOString().slice(0, 10);
  const current = `effective_to.is.null,effective_to.gt.${today}`;

  const [customersRes, locationsRes, catalogRes, sellRes, overrideRes] = await Promise.all([
    supabase.from("customers").select("id, code, name").eq("active", true).order("name"),
    supabase
      .from("customer_locations")
      .select(
        "id, customer_id, code, location_number, name, address_raw, fulfillment, routing_notes, dock_note, affiliates(display_name)",
      )
      .eq("active", true)
      .eq("market", "US")
      .order("code"),
    supabase.from("catalog_items").select("id, sku, name, category").eq("active", true).order("category").order("sku"),
    supabase
      .from("sell_prices")
      .select("catalog_item_id, amount, effective_from")
      .eq("market", "US")
      .lte("effective_from", today)
      .or(current)
      .order("effective_from", { ascending: false }),
    supabase
      .from("customer_price_overrides")
      .select("customer_id, catalog_item_id, amount, effective_from")
      .eq("market", "US")
      .lte("effective_from", today)
      .or(current)
      .order("effective_from", { ascending: false }),
  ]);

  const fleet = newest((sellRes.data ?? []) as PriceRow[], (r) => r.catalog_item_id);
  const overrides: Record<string, Record<string, number>> = {};
  for (const [, r] of newest((overrideRes.data ?? []) as OverrideRow[], (r) => `${r.customer_id}:${r.catalog_item_id}`)) {
    (overrides[r.customer_id] ??= {})[r.catalog_item_id] = Number(r.amount);
  }

  const catalog: CatalogOption[] = (
    (catalogRes.data ?? []) as { id: string; sku: string; name: string; category: string }[]
  ).map((c) => ({ ...c, fleetPrice: fleet.has(c.id) ? Number(fleet.get(c.id)!.amount) : null }));

  type LocRow = Omit<LocationOption, "shopName"> & {
    affiliates: { display_name: string } | { display_name: string }[] | null;
  };
  const locations: LocationOption[] = ((locationsRes.data ?? []) as unknown as LocRow[]).map(
    ({ affiliates, ...l }) => ({ ...l, shopName: one(affiliates)?.display_name ?? null }),
  );

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
