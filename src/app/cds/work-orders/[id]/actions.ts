"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-wo/ActionForm";
import { isUuid, LINES_LOCKED_STATUSES, REVIEW_STATUSES, text } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const REQUEST_TYPES = ["service", "parts_only"];
const FULFILLMENT = ["pickup", "shipping", "supplier_direct", "unspecified"];
const DIRECTIONS = ["customer_to_affiliate", "affiliate_to_customer", "cds_to_customer", "customer_to_cds", "supplier_to_customer"];
const CARRIERS = ["UPS", "FedEx", "Other"];
const SHIPMENT_STATUSES = [
  "label_created",
  "awaiting_pickup",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delayed",
  "exception",
  "address_problem",
  "no_scan",
];
const CDS_STATUS_MOVES = ["delivered", "ready_to_invoice", "cancelled", "pending_review"];

function done(woId: string, ok: string): ActionState {
  revalidatePath(`/cds/work-orders/${woId}`);
  revalidatePath("/cds");
  return { ok, at: Date.now() };
}

/** Optional money / number field: empty -> null, bad -> NaN. */
function optionalNumber(value: FormDataEntryValue | null): number | null {
  const s = text(value);
  if (!s) return null;
  return Number(s);
}

async function currentStatus(supabase: Awaited<ReturnType<typeof createClient>>, woId: string) {
  const { data } = await supabase.from("work_orders").select("status").eq("id", woId).maybeSingle();
  return (data?.status as string | undefined) ?? null;
}

export async function dispatchWorkOrder(woId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const shop = text(formData.get("affiliate_id"));
  if (!isUuid(woId)) return { error: "Work order not found." };
  if (!isUuid(shop)) return { error: "Choose a shop to dispatch to." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cds_dispatch_work_order", { p_work_order: woId, p_affiliate: shop });
  if (error) return { error: error.message };
  return done(woId, "Dispatched. The shop can now see this work order.");
}

export async function updateWorkOrderFields(woId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const profile = await requireCds();
  if (!isUuid(woId)) return { error: "Work order not found." };
  const unit = text(formData.get("unit_number"));
  const requested = text(formData.get("requested_work"));
  const label = text(formData.get("location_label"));
  const requestType = text(formData.get("request_type"));
  const fulfillment = text(formData.get("fulfillment"));
  if (!unit || !requested) return { error: "Unit number and requested work are required." };
  if (!label) return { error: "Location is required." };
  if (!REQUEST_TYPES.includes(requestType)) return { error: "Choose a request type." };
  if (!FULFILLMENT.includes(fulfillment)) return { error: "Choose a fulfillment method." };

  const supabase = await createClient();
  const status = await currentStatus(supabase, woId);
  if (!status) return { error: "Work order not found." };
  if (!REVIEW_STATUSES.includes(status)) return { error: "Order details can only be edited while the order is in review." };

  const { error } = await supabase
    .from("work_orders")
    .update({
      unit_number: unit,
      po_number: text(formData.get("po_number")) || null,
      location_label: label,
      site_address: text(formData.get("site_address")) || null,
      requested_work: requested,
      request_type: requestType,
      fulfillment,
    })
    .eq("id", woId);
  if (error) return { error: error.message };
  await supabase.from("work_order_events").insert({
    work_order_id: woId,
    actor_id: profile.id,
    event_type: "edit",
    message: "Order details edited by CDS",
    shop_visible: false,
  });
  return done(woId, "Order details saved.");
}

export async function addShipment(woId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const profile = await requireCds();
  if (!isUuid(woId)) return { error: "Work order not found." };
  const direction = text(formData.get("direction"));
  const carrier = text(formData.get("carrier"));
  const status = text(formData.get("status"));
  const tracking = text(formData.get("tracking_number"));
  const quoted = optionalNumber(formData.get("quoted_cost"));
  const actual = optionalNumber(formData.get("actual_cost"));
  if (!DIRECTIONS.includes(direction)) return { error: "Choose a direction." };
  if (!CARRIERS.includes(carrier)) return { error: "Choose a carrier." };
  if (!SHIPMENT_STATUSES.includes(status)) return { error: "Choose a shipment status." };
  if ((quoted !== null && !(quoted >= 0)) || (actual !== null && !(actual >= 0))) {
    return { error: "Costs must be numbers of zero or more." };
  }

  const supabase = await createClient();
  const { data: shipment, error } = await supabase
    .from("shipments")
    .insert({
      work_order_id: woId,
      direction,
      carrier,
      service_level: text(formData.get("service_level")) || null,
      tracking_number: tracking || null,
      status,
      label_status: tracking ? "ready" : "needed",
    })
    .select("id")
    .single();
  if (error || !shipment) {
    if (error?.code === "23505") return { error: "That tracking number is already on a shipment for this carrier." };
    return { error: error?.message ?? "The shipment could not be saved." };
  }
  const { error: internalError } = await supabase.from("shipment_internal").insert({
    shipment_id: shipment.id,
    notes: text(formData.get("notes")) || null,
    quoted_cost: quoted,
    actual_cost: actual,
  });
  if (internalError) return { error: `Shipment saved, but notes and costs were not: ${internalError.message}` };
  await supabase.from("work_order_events").insert({
    work_order_id: woId,
    actor_id: profile.id,
    event_type: "shipment",
    message: `Shipment added: ${carrier}${tracking ? ` ${tracking}` : ""}`,
    shop_visible: false,
  });
  return done(woId, "Shipment added.");
}

export async function addLine(woId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const profile = await requireCds();
  if (!isUuid(woId)) return { error: "Work order not found." };
  const item = text(formData.get("catalog_item_id"));
  const qty = Number(text(formData.get("qty")));
  if (!isUuid(item)) return { error: "Choose a catalog item." };
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Quantity must be more than zero." };

  const supabase = await createClient();
  const status = await currentStatus(supabase, woId);
  if (!status) return { error: "Work order not found." };
  if (LINES_LOCKED_STATUSES.includes(status)) return { error: "Lines cannot change once the work is completed." };

  const { error } = await supabase
    .from("work_order_lines")
    .insert({ work_order_id: woId, catalog_item_id: item, qty, origin: "cds_order" });
  if (error) {
    if (error.message.startsWith("No customer price")) return { error: "This item has no customer price yet. Set a fleet price first." };
    return { error: error.message };
  }
  await supabase.from("work_order_events").insert({
    work_order_id: woId,
    actor_id: profile.id,
    event_type: "line_added",
    message: "CDS added a line",
    shop_visible: !REVIEW_STATUSES.includes(status),
  });
  return done(woId, "Line added.");
}

export async function removeLine(woId: string, lineId: string): Promise<ActionState> {
  const profile = await requireCds();
  if (!isUuid(woId) || !isUuid(lineId)) return { error: "Line not found." };
  const supabase = await createClient();
  const status = await currentStatus(supabase, woId);
  if (!status) return { error: "Work order not found." };
  if (LINES_LOCKED_STATUSES.includes(status)) return { error: "Lines cannot change once the work is completed." };

  const { data, error } = await supabase
    .from("work_order_lines")
    .delete()
    .eq("id", lineId)
    .eq("work_order_id", woId)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Line not found." };
  await supabase.from("work_order_events").insert({
    work_order_id: woId,
    actor_id: profile.id,
    event_type: "line_removed",
    message: "CDS removed a line",
    shop_visible: !REVIEW_STATUSES.includes(status),
  });
  return done(woId, "Line removed.");
}

export async function decideAuthorization(
  woId: string,
  requestId: string,
  approve: boolean,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireCds();
  if (!isUuid(woId) || !isUuid(requestId)) return { error: "Request not found." };
  const approvedBy = text(formData.get("customer_approved_by"));
  if (approve && !approvedBy) return { error: "Record who at the customer approved the extra work." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cds_decide_authorization", {
    p_request: requestId,
    p_approve: approve,
    p_decision_note: text(formData.get("decision_note")) || null,
    p_customer_approved_by: approve ? approvedBy : null,
  });
  if (error) return { error: error.message };
  return done(woId, approve ? "Extra work approved and added to the order." : "Extra work declined.");
}

export async function setStatus(woId: string, status: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  if (!isUuid(woId)) return { error: "Work order not found." };
  if (!CDS_STATUS_MOVES.includes(status)) return { error: "That status change is not available here." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cds_set_status", {
    p_work_order: woId,
    p_status: status,
    p_note: text(formData.get("note")) || null,
  });
  if (error) return { error: error.message };
  return done(woId, "Status updated.");
}

export async function updateTax(woId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const profile = await requireCds();
  if (!isUuid(woId)) return { error: "Work order not found." };
  const rate = Number(text(formData.get("tax_rate")) || "0");
  if (!Number.isFinite(rate) || rate < 0 || rate >= 100) return { error: "Tax rate must be a percentage between 0 and 100." };
  const supabase = await createClient();
  const status = await currentStatus(supabase, woId);
  if (!status) return { error: "Work order not found." };
  if (status === "invoiced") return { error: "Tax cannot change after the order is invoiced." };
  const { error } = await supabase
    .from("work_order_internal")
    .update({
      tax_rate: Math.round(rate * 1000) / 1000,
      tax_parts: formData.get("tax_parts") === "on",
      tax_labor: formData.get("tax_labor") === "on",
      tax_shipping: formData.get("tax_shipping") === "on",
      tax_source: "manual",
    })
    .eq("work_order_id", woId);
  if (error) return { error: error.message };
  await supabase.from("work_order_events").insert({
    work_order_id: woId,
    actor_id: profile.id,
    event_type: "tax",
    message: `Tax settings changed: ${rate}%`,
    shop_visible: false,
  });
  return done(woId, "Tax settings saved.");
}
