"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-wo/ActionForm";
import { isUuid, LINES_LOCKED_STATUSES, REVIEW_STATUSES, text } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { recordSync } from "@/lib/integration-sync";
import { passThroughInput } from "@/lib/pass-through";
import { createInvoice, type CreatedInvoice } from "@/lib/qbo/api";
import { QboError } from "@/lib/qbo/client";
import { loadInvoice } from "@/lib/qbo/invoice-input";
import { createdNote, type PendingQbInvoice } from "@/lib/qbo/pending";
import { qboApi } from "@/lib/qbo/tokens";
import { createClient } from "@/lib/supabase/server";

const REQUEST_TYPES = ["service", "parts_only"];
const FULFILLMENT = ["pickup", "shipping", "supplier_direct", "unspecified"];
const DIRECTIONS = ["customer_to_affiliate", "affiliate_to_customer", "cds_to_customer", "customer_to_cds", "supplier_to_customer"];
const CARRIERS = ["UPS", "FedEx", "USPS", "Other"];
const SHIPMENT_STATUSES = [
  "label_needed",
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
  const poNumber = text(formData.get("po_number"));
  const siteAddress = text(formData.get("site_address"));
  const limits: [string, number][] = [
    [unit, 100],
    [poNumber, 100],
    [label, 200],
    [siteAddress, 500],
    [requested, 2000],
  ];
  const tooLong = limits.find(([value, max]) => value.length > max);
  if (tooLong) return { error: `Text is too long (max ${tooLong[1]} characters)` };

  const supabase = await createClient();
  const status = await currentStatus(supabase, woId);
  if (!status) return { error: "Work order not found." };
  if (!REVIEW_STATUSES.includes(status)) return { error: "Order details can only be edited while the order is in review." };

  const { error } = await supabase
    .from("work_orders")
    .update({
      unit_number: unit,
      po_number: poNumber || null,
      location_label: label,
      site_address: siteAddress || null,
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

/** Misc. hardware and other items priced per line: the amount from the shop's invoice, billed as is. */
export async function addPassThroughLine(woId: string, itemId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  if (!isUuid(woId) || !isUuid(itemId)) return { error: "Work order not found." };
  const input = passThroughInput(text(formData.get("description")), text(formData.get("amount")));
  if (!input.ok) return { error: input.error };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cds_add_pass_through_line", {
    p_work_order: woId,
    p_catalog_item: itemId,
    p_description: input.description,
    p_amount: input.amount,
  });
  if (error) return { error: error.message };
  return done(woId, "Line added at the amount on the shop's invoice.");
}

export async function removePassThroughLine(woId: string, lineId: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(woId) || !isUuid(lineId)) return { error: "Line not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cds_remove_pass_through_line", { p_line: lineId });
  if (error) return { error: error.message };
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

// ---------------------------------------------------------------- QuickBooks invoice

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function logSync(
  supabase: Supabase,
  woId: string,
  status: "ok" | "rejected" | "error",
  externalId: string | null,
  /** The failure, or on an 'ok' row the note from createdNote. */
  error: string | null,
) {
  await recordSync(supabase, {
    system: "quickbooks",
    entity: "invoice",
    entity_id: woId,
    external_id: externalId,
    direction: "push",
    status,
    error: error ? error.slice(0, 2000) : null,
  });
}

/**
 * Creates the customer invoice in QuickBooks and marks the work order Invoiced.
 *
 * Never creates a second invoice for a work order:
 *   * nothing is sent once the order has a QuickBooks invoice or is no longer Ready to Invoice;
 *   * the request carries Intuit's requestid (the work order id), so a retry after a timeout,
 *     a lost response or a failed portal update gets the original invoice back instead of
 *     a new one. Only after QuickBooks has refused a request outright (HTTP 4xx, so nothing
 *     was created) does the next attempt use a new id ("<id>-r<n>"), because QuickBooks
 *     would otherwise answer the corrected request with the stored refusal.
 */
export async function createQuickBooksInvoice(woId: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(woId)) return { error: "Work order not found." };
  const supabase = await createClient();

  let invoice;
  try {
    invoice = await loadInvoice(supabase, woId);
  } catch {
    return { error: "The work order could not be read. Try again." };
  }
  if (!invoice) return { error: "Work order not found." };
  if (invoice.qbInvoiceId) {
    return { error: `This work order already has QuickBooks invoice ${invoice.qbInvoiceNumber ?? invoice.qbInvoiceId}.` };
  }
  if (invoice.pendingQb) return recordPendingInvoice(supabase, woId, invoice.status, invoice.pendingQb);
  if (invoice.status !== "ready_to_invoice") return { error: "Only a work order that is Ready to Invoice can be invoiced." };
  if (!invoice.result.ok) return { error: `Fix these first: ${invoice.result.problems.join(" ")}` };
  const payload = invoice.result.payload;

  const { count, error: countError } = await supabase
    .from("integration_sync")
    .select("id", { count: "exact", head: true })
    .eq("system", "quickbooks")
    .eq("entity", "invoice")
    .eq("entity_id", woId)
    .eq("status", "rejected");
  if (countError) return { error: "The QuickBooks history of this order could not be read. Try again." };
  const requestId = count ? `${woId}-r${count}` : woId;

  let created: CreatedInvoice;
  try {
    let api = await qboApi();
    try {
      created = await createInvoice(api, payload, requestId);
    } catch (e) {
      if (!(e instanceof QboError && e.unauthorized)) throw e;
      // The access token was revoked or expired early: refresh once and send the same request.
      api = await qboApi({ forceRefresh: true });
      created = await createInvoice(api, payload, requestId);
    }
  } catch (e) {
    const qbo = e instanceof QboError ? e : null;
    const message = e instanceof Error ? e.message : "unknown error";
    if (qbo?.faultType === "Config") return { error: message };
    await logSync(supabase, woId, qbo?.rejected ? "rejected" : "error", null,
      `${message}${qbo?.intuitTid ? ` (intuit_tid ${qbo.intuitTid})` : ""}`);
    return {
      error: qbo?.rejected
        ? `QuickBooks refused the invoice: ${message}`
        : `QuickBooks did not confirm the invoice (${message}). Try again: a retry never creates a second invoice.`,
    };
  }

  // Recorded before the work order is marked, so a failed update leaves the invoice findable
  // (see @/lib/qbo/pending) and the next click records it instead of sending a new one.
  await logSync(supabase, woId, "ok", created.Id, createdNote(created.DocNumber));
  const { error } = await supabase.rpc("cds_mark_invoiced", {
    p_work_order: woId,
    p_qb_invoice_id: created.Id,
    p_qb_invoice_number: created.DocNumber ?? null,
  });
  if (error) {
    await logSync(supabase, woId, "error", created.Id, `Invoice created in QuickBooks, portal not updated: ${error.message}`);
    return {
      error: `QuickBooks invoice ${created.DocNumber ?? created.Id} was created, but the work order could not be updated (${error.message}). Click again to finish; no second invoice is created.`,
    };
  }
  return done(woId, `QuickBooks invoice ${created.DocNumber ?? created.Id} created. The work order is now Invoiced.`);
}

/**
 * QuickBooks already created an invoice for this order but the work order was not marked
 * (see @/lib/qbo/pending). Records that invoice; never sends a new one.
 */
async function recordPendingInvoice(supabase: Supabase, woId: string, status: string, pending: PendingQbInvoice): Promise<ActionState> {
  const name = pending.number ?? `id ${pending.id}`;
  if (status !== "ready_to_invoice") {
    return {
      error: `QuickBooks invoice ${name} was created for this work order but is not recorded on it, and the order is no longer Ready to Invoice. Check the invoice in QuickBooks and void it there if it should not exist.`,
    };
  }
  const { error } = await supabase.rpc("cds_mark_invoiced", {
    p_work_order: woId,
    p_qb_invoice_id: pending.id,
    p_qb_invoice_number: pending.number,
  });
  if (error) {
    await logSync(supabase, woId, "error", pending.id, `Invoice created in QuickBooks, portal not updated: ${error.message}`);
    return {
      error: `QuickBooks invoice ${name} exists, but the work order could not be updated (${error.message}). Click again to finish; no second invoice is created.`,
    };
  }
  return done(woId, `QuickBooks invoice ${name} (created earlier) is now recorded. The work order is now Invoiced.`);
}
