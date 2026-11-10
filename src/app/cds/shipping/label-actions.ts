"use server";

import { revalidatePath } from "next/cache";
import { requireCds } from "@/lib/auth";
import {
  createLabelForShipment,
  ratesForShipment,
  voidLabel,
  type LabelChoice,
  type LabelResult,
  type RatesResult,
} from "@/lib/shipstation/labels";
import { packageFromForm, type PackageForm } from "@/lib/shipstation/package";
import type { PickupForm } from "@/lib/shipstation/pickup-requests";
import { cancelPickup, schedulePickupForLabel, type PickupResult } from "@/lib/shipstation/pickups";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refresh(woId: string) {
  revalidatePath("/cds/shipping");
  if (UUID.test(woId)) revalidatePath(`/cds/work-orders/${woId}`);
}

/**
 * Live rates for a shipment leg from the carriers CDS turned on, for the package typed in the
 * rates box. The package is saved on the shipment first, so the label is bought for the same
 * package. CDS only.
 */
export async function getShipmentRates(shipmentId: string, form: PackageForm): Promise<RatesResult> {
  await requireCds();
  if (!UUID.test(shipmentId)) return { ok: false, error: "Shipment not found." };
  const parsed = packageFromForm({
    weightLb: String(form?.weightLb ?? ""),
    lengthIn: String(form?.lengthIn ?? ""),
    widthIn: String(form?.widthIn ?? ""),
    heightIn: String(form?.heightIn ?? ""),
  });
  if (!parsed.ok) return parsed;
  const { pkg } = parsed;

  const supabase = await createClient();
  const { count, error: labelError } = await supabase
    .from("shipment_labels")
    .select("id", { count: "exact", head: true })
    .eq("shipment_id", shipmentId)
    .eq("status", "active");
  if (labelError) return { ok: false, error: "The shipment could not be read. Try again." };
  if ((count ?? 0) > 0) return { ok: false, error: "This shipment already has a label. Void it before getting new rates." };

  const { data: saved, error } = await supabase
    .from("shipments")
    .update({ weight_lb: pkg.weightLb, length_in: pkg.lengthIn, width_in: pkg.widthIn, height_in: pkg.heightIn })
    .eq("id", shipmentId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: "Could not save the package weight and size. Try again." };
  if (!saved) return { ok: false, error: "Shipment not found." };
  return ratesForShipment(supabase, shipmentId);
}

/** Creates the label for the chosen rate (a test label while SHIPSTATION_TEST_LABELS is on). CDS only. */
export async function createShipmentLabel(shipmentId: string, woId: string, choice: LabelChoice): Promise<LabelResult> {
  await requireCds();
  if (!UUID.test(shipmentId)) return { ok: false, error: "Shipment not found." };
  const carrierId = String(choice?.carrierId ?? "");
  const serviceCode = String(choice?.serviceCode ?? "");
  if (!/^se-[0-9]+$/.test(carrierId) || !/^[a-z0-9_]{2,80}$/.test(serviceCode)) return { ok: false, error: "Choose a rate first." };
  const quoted = Number(choice.quotedTotal);
  const days = Number(choice.deliveryDays);
  const result = await createLabelForShipment(await createClient(), shipmentId, {
    carrierId,
    serviceCode,
    rateId: typeof choice.rateId === "string" ? choice.rateId.slice(0, 60) : null,
    quotedTotal: Number.isFinite(quoted) && quoted >= 0 ? Math.round(quoted * 100) / 100 : null,
    deliveryDays: Number.isInteger(days) && days >= 0 ? days : null,
  });
  refresh(woId);
  return result;
}

/** Voids a label in ShipStation (a test label only in the portal). CDS only. */
export async function voidShipmentLabel(labelId: string, woId: string): Promise<LabelResult> {
  await requireCds();
  if (!UUID.test(labelId)) return { ok: false, error: "Label not found." };
  const result = await voidLabel(await createClient(), labelId);
  refresh(woId);
  return result;
}

/** Books a carrier pickup for a real label in use (never for a test label). CDS only. */
export async function scheduleLabelPickup(labelId: string, woId: string, form: PickupForm): Promise<PickupResult> {
  await requireCds();
  if (!UUID.test(labelId)) return { ok: false, error: "Label not found." };
  const result = await schedulePickupForLabel(await createClient(), labelId, {
    date: String(form?.date ?? "").slice(0, 20),
    readyTime: String(form?.readyTime ?? "").slice(0, 10),
    closeTime: String(form?.closeTime ?? "").slice(0, 10),
    notes: String(form?.notes ?? "").slice(0, 1000),
  });
  refresh(woId);
  return result;
}

/** Cancels a carrier pickup in ShipStation and in the portal. CDS only. */
export async function cancelLabelPickup(pickupId: string, woId: string): Promise<PickupResult> {
  await requireCds();
  if (!UUID.test(pickupId)) return { ok: false, error: "Pickup not found." };
  const result = await cancelPickup(await createClient(), pickupId);
  refresh(woId);
  return result;
}
