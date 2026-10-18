import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LabelView } from "@/components/shipping/LabelPanel";
import { shipStationConfig } from "./config";

type Row = {
  id: string;
  shipment_id: string;
  carrier: string;
  service_name: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  is_test: boolean;
  shipment_label_costs?: { label_cost: number | string; insurance_cost: number | string } | { label_cost: number | string; insurance_cost: number | string }[] | null;
};

/** Whether the server can talk to ShipStation (no secret leaves the server). */
export function shipStationConfigured(): boolean {
  return shipStationConfig() !== null;
}

/**
 * The label in use on each shipment leg, by shipment id. `withCost` (CDS pages only) adds
 * what the label cost; shops cannot read shipment_label_costs at all.
 */
export async function activeLabels(
  db: SupabaseClient,
  by: { workOrderId: string } | { shipmentIds: string[] },
  withCost: boolean,
): Promise<Map<string, LabelView>> {
  const cols = "id, shipment_id, carrier, service_name, tracking_number, tracking_url, is_test";
  let query = db.from("shipment_labels").select(withCost ? `${cols}, shipment_label_costs(label_cost, insurance_cost)` : cols).eq("status", "active");
  if ("workOrderId" in by) query = query.eq("work_order_id", by.workOrderId);
  else {
    if (!by.shipmentIds.length) return new Map();
    query = query.in("shipment_id", by.shipmentIds.slice(0, 300));
  }
  const { data } = await query;
  const out = new Map<string, LabelView>();
  for (const r of (data ?? []) as unknown as Row[]) {
    const c = Array.isArray(r.shipment_label_costs) ? r.shipment_label_costs[0] : r.shipment_label_costs;
    out.set(r.shipment_id, {
      id: r.id,
      carrier: r.carrier,
      service_name: r.service_name,
      tracking_number: r.tracking_number,
      tracking_url: r.tracking_url,
      is_test: r.is_test,
      cost: withCost && c ? Math.round((Number(c.label_cost) + Number(c.insurance_cost)) * 100) / 100 : null,
    });
  }
  return out;
}
