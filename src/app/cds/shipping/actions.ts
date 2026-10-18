"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { dbMessage, optionalAmount, optionalText, text } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DIRECTIONS, LABEL_STATUSES, PACKAGE_TYPES, SHIPMENT_STATUSES } from "./options";

type Parsed = { error: string } | { shipment: Record<string, unknown>; internal: Record<string, unknown> };

function parse(formData: FormData): Parsed {
  const direction = text(formData, "direction");
  const carrier = optionalText(formData, "carrier");
  const labelStatus = text(formData, "label_status");
  const status = text(formData, "status");
  const packageType = optionalText(formData, "package_type");
  if (!DIRECTIONS.includes(direction)) return { error: "Choose a shipment direction." };
  if (carrier && !["UPS", "FedEx", "USPS", "Other"].includes(carrier)) return { error: "Choose UPS, FedEx, USPS or Other." };
  if (!LABEL_STATUSES.some((s) => s.value === labelStatus)) return { error: "Choose a label status." };
  if (!SHIPMENT_STATUSES.includes(status)) return { error: "Choose a shipment status." };
  if (packageType && !PACKAGE_TYPES.some((p) => p.value === packageType)) return { error: "Choose a package type." };

  const numbers: Record<string, number | null> = {};
  for (const name of ["weight_lb", "length_in", "width_in", "height_in", "quoted_cost", "actual_cost"]) {
    const n = optionalAmount(formData, name);
    if (Number.isNaN(n)) return { error: "Weights, sizes and costs must be numbers of zero or more." };
    numbers[name] = n;
  }

  const tracking = optionalText(formData, "tracking_number");
  if (tracking && !carrier) return { error: "Choose the carrier for this tracking number." };

  return {
    shipment: {
      direction,
      carrier,
      service_level: optionalText(formData, "service_level"),
      tracking_number: tracking,
      label_status: labelStatus,
      status,
      package_type: packageType,
      weight_lb: numbers.weight_lb,
      length_in: numbers.length_in,
      width_in: numbers.width_in,
      height_in: numbers.height_in,
      ship_from: optionalText(formData, "ship_from"),
      ship_to: optionalText(formData, "ship_to"),
      eta_text: optionalText(formData, "eta_text"),
    },
    internal: {
      notes: optionalText(formData, "notes"),
      quoted_cost: numbers.quoted_cost,
      actual_cost: numbers.actual_cost,
    },
  };
}

function trackingMessage(error: { code?: string; message?: string }) {
  return error.code === "23505"
    ? "That tracking number is already on another shipment for this carrier."
    : dbMessage(error, "Could not save the shipment.");
}

export async function createShipment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const workOrderId = text(formData, "work_order_id");
  if (!workOrderId) return { error: "Choose a work order." };
  const parsed = parse(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shipments")
    .insert({ work_order_id: workOrderId, ...parsed.shipment })
    .select("id")
    .single();
  if (error || !data) return { error: error ? trackingMessage(error) : "Could not save the shipment." };

  const { error: internalError } = await supabase
    .from("shipment_internal")
    .insert({ shipment_id: data.id, ...parsed.internal });
  revalidatePath("/cds/shipping");
  if (internalError) {
    return { error: "The shipment was saved, but its notes and costs were not. Edit the shipment to add them." };
  }
  return { ok: true, message: "Shipment saved." };
}

export async function updateShipment(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const parsed = parse(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  const { error } = await supabase.from("shipments").update(parsed.shipment).eq("id", id);
  if (error) return { error: trackingMessage(error) };
  const { error: internalError } = await supabase
    .from("shipment_internal")
    .upsert({ shipment_id: id, ...parsed.internal });
  revalidatePath("/cds/shipping");
  if (internalError) return { error: "The shipment was saved, but its notes and costs were not." };
  return { ok: true, message: "Shipment updated." };
}

/** Quick status change from the table row. */
export async function setShipmentStatus(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const status = text(formData, "status");
  if (!SHIPMENT_STATUSES.includes(status)) return { error: "Choose a status." };
  const supabase = await createClient();
  const { error } = await supabase.from("shipments").update({ status }).eq("id", id);
  if (error) return { error: dbMessage(error) };
  revalidatePath("/cds/shipping");
  return { ok: true, message: "Saved." };
}
