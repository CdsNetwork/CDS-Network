import type { SupabaseClient } from "@supabase/supabase-js";
import type { LocationOption } from "@/components/cds-wo/NewWorkOrderForm";
import { one } from "@/components/cds-wo/util";
import { fetchAllSettled } from "@/lib/supabase/fetch-all";

const COLUMNS =
  "id, customer_id, code, location_number, name, address_raw, city, region, postal_code, fulfillment, routing_notes, dock_note, affiliates(display_name)";

type LocRow = Omit<LocationOption, "shopName"> & {
  affiliates: { display_name: string } | { display_name: string }[] | null;
};

/** Every active US customer location for the Create Work Order picker, read in pages. */
export async function loadPickerLocations(supabase: SupabaseClient) {
  const res = await fetchAllSettled<LocRow>((from, to) =>
    supabase
      .from("customer_locations")
      .select(COLUMNS)
      .eq("active", true)
      .eq("market", "US")
      .order("code")
      .order("id")
      .range(from, to),
  );
  if (res.error) return res;
  const data: LocationOption[] = res.data.map(({ affiliates, ...l }) => ({ ...l, shopName: one(affiliates)?.display_name ?? null }));
  return { data, error: null };
}
