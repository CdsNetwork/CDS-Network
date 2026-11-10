import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LabelView } from "@/components/shipping/LabelPanel";
import type { PickupView } from "@/components/shipping/PickupPanel";
import { shipStationConfig } from "./config";
import type { DefaultPackage } from "./package";
import { pickupRefusal } from "./pickup-requests";

type Row = {
  id: string;
  shipment_id: string;
  carrier: string;
  service_name: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  is_test: boolean;
  shop_affiliate_id?: string | null;
  affiliates?: { display_name: string } | { display_name: string }[] | null;
  shipment_label_costs?: { label_cost: number | string; insurance_cost: number | string } | { label_cost: number | string; insurance_cost: number | string }[] | null;
};

/** Whether the server can talk to ShipStation (no secret leaves the server). */
export function shipStationConfigured(): boolean {
  return shipStationConfig() !== null;
}

/**
 * The label in use on each shipment leg, by shipment id. `withCost` (CDS pages only) adds
 * what the label cost, its carrier pickup and the shop it was made for; shops cannot read
 * shipment_label_costs or shipment_pickups at all.
 */
export async function activeLabels(
  db: SupabaseClient,
  by: { workOrderId: string } | { shipmentIds: string[] },
  withCost: boolean,
): Promise<Map<string, LabelView>> {
  const cols = "id, shipment_id, carrier, service_name, tracking_number, tracking_url, is_test";
  const select = () => db.from("shipment_labels").select(withCost ? `${cols}, shop_affiliate_id, affiliates(display_name), shipment_label_costs(label_cost, insurance_cost)` : cols).eq("status", "active");
  // At most one active label per leg, so each request returns no more rows than ids asked for.
  const groups: string[][] = [];
  if ("workOrderId" in by) groups.push([]);
  else for (let i = 0; i < by.shipmentIds.length; i += 100) groups.push(by.shipmentIds.slice(i, i + 100));
  const results = await Promise.all(
    groups.map((ids) => ("workOrderId" in by ? select().eq("work_order_id", by.workOrderId) : select().in("shipment_id", ids))),
  );
  // CDS pages: the carrier pickup booked for each label (shops cannot read shipment_pickups).
  const pickups = new Map<string, PickupView>();
  const config = withCost ? shipStationConfig() : null;
  if (withCost) {
    const labelIds = results.flatMap((res) => (res.data ?? []) as unknown as Row[]).map((r) => r.id);
    const chunks: string[][] = [];
    for (let i = 0; i < labelIds.length; i += 100) chunks.push(labelIds.slice(i, i + 100));
    const found = await Promise.all(
      chunks.map((ids) =>
        db
          .from("shipment_pickups")
          .select("id, label_id, confirmation_number, carrier, window_start, window_end, time_zone, notes")
          .eq("status", "scheduled")
          .in("label_id", ids),
      ),
    );
    for (const p of found.flatMap((res) => res.data ?? []) as (PickupView & { label_id: string })[]) {
      const { label_id, ...view } = p;
      pickups.set(label_id, view);
    }
  }
  const out = new Map<string, LabelView>();
  for (const r of results.flatMap((res) => res.data ?? []) as unknown as Row[]) {
    const c = Array.isArray(r.shipment_label_costs) ? r.shipment_label_costs[0] : r.shipment_label_costs;
    const shop = Array.isArray(r.affiliates) ? r.affiliates[0] : r.affiliates;
    out.set(r.shipment_id, {
      id: r.id,
      carrier: r.carrier,
      service_name: r.service_name,
      tracking_number: r.tracking_number,
      tracking_url: r.tracking_url,
      is_test: r.is_test,
      cost: withCost && c ? Math.round((Number(c.label_cost) + Number(c.insurance_cost)) * 100) / 100 : null,
      ...(withCost
        ? {
            pickup: pickups.get(r.id) ?? null,
            pickupRefusal: pickupRefusal(r, config?.testLabels ?? false),
            shop: r.shop_affiliate_id ? { id: r.shop_affiliate_id, name: shop?.display_name ?? null } : null,
          }
        : {}),
    });
  }
  return out;
}

/**
 * The Shipping settings default package (CDS pages only), to prefill the rates box when a
 * shipment has no saved weight. Null when it cannot be read; the rates box then starts empty
 * for those shipments.
 */
export async function defaultPackage(db: SupabaseClient): Promise<DefaultPackage | null> {
  const { data, error } = await db
    .from("shipping_settings")
    .select("default_weight_lb, default_length_in, default_width_in, default_height_in")
    .maybeSingle();
  return error ? null : ((data as DefaultPackage | null) ?? null);
}
