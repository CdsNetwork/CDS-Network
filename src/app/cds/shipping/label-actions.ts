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
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refresh(woId: string) {
  revalidatePath("/cds/shipping");
  if (UUID.test(woId)) revalidatePath(`/cds/work-orders/${woId}`);
}

/** Live rates for a shipment leg from the carriers CDS turned on. CDS only. */
export async function getShipmentRates(shipmentId: string): Promise<RatesResult> {
  await requireCds();
  if (!UUID.test(shipmentId)) return { ok: false, error: "Shipment not found." };
  return ratesForShipment(await createClient(), shipmentId);
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
