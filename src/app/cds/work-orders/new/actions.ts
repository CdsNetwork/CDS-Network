"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/cds-wo/ActionForm";
import { isUuid, text } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const REQUEST_TYPES = ["service", "parts_only"];
const FULFILLMENT = ["pickup", "shipping", "supplier_direct", "unspecified"];

export async function createWorkOrder(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();

  const customer = text(formData.get("customer_id"));
  const location = text(formData.get("location_id"));
  const requestType = text(formData.get("request_type"));
  const fulfillment = text(formData.get("fulfillment"));
  if (!isUuid(customer)) return { error: "Choose a customer." };
  if (location && !isUuid(location)) return { error: "Choose a location from the list, or clear it." };
  if (!REQUEST_TYPES.includes(requestType)) return { error: "Choose a request type." };
  if (!FULFILLMENT.includes(fulfillment)) return { error: "Choose a fulfillment method." };

  let lines: { catalog_item_id: string; qty: number }[] = [];
  try {
    const parsed: unknown = JSON.parse(text(formData.get("lines")) || "[]");
    if (!Array.isArray(parsed)) throw new Error("bad lines");
    lines = parsed.map((l: { catalog_item_id?: unknown; qty?: unknown }) => {
      const qty = Number(l.qty);
      if (!isUuid(l.catalog_item_id) || !Number.isFinite(qty) || qty <= 0) throw new Error("bad line");
      return { catalog_item_id: l.catalog_item_id, qty };
    });
  } catch {
    return { error: "One of the services or parts is not valid. Remove it and add it again." };
  }

  const supabase = await createClient();
  const { data: woId, error } = await supabase.rpc("cds_create_work_order", {
    p_customer: customer,
    p_location: location || null,
    p_location_label: location ? null : text(formData.get("location_text")) || null,
    p_site_address: text(formData.get("site_address")) || null,
    p_request_type: requestType,
    p_fulfillment: fulfillment,
    p_unit_number: text(formData.get("unit_number")),
    p_po_number: text(formData.get("po_number")) || null,
    p_requested_work: text(formData.get("requested_work")),
    p_internal_notes: text(formData.get("internal_notes")) || null,
    p_lines: lines,
  });
  if (error || !woId) return { error: error?.message ?? "The work order could not be created." };

  // Starting tax rate from the location's state (manual US table). CDS can change it on the order.
  if (location) {
    const { data: loc } = await supabase.from("customer_locations").select("region, market").eq("id", location).maybeSingle();
    if (loc?.region) {
      const { data: rate } = await supabase
        .from("tax_rates")
        .select("rate, taxes_parts, taxes_labor, taxes_shipping")
        .eq("market", loc.market)
        .eq("region", loc.region)
        .is("postal_code", null)
        .maybeSingle();
      if (rate) {
        await supabase
          .from("work_order_internal")
          .update({
            tax_rate: rate.rate,
            tax_parts: rate.taxes_parts,
            tax_labor: rate.taxes_labor,
            tax_shipping: rate.taxes_shipping,
            tax_jurisdiction: loc.region,
            tax_source: "state_fallback",
          })
          .eq("work_order_id", woId);
      }
    }
  }

  revalidatePath("/cds");
  redirect(`/cds/work-orders/${woId}`);
}
