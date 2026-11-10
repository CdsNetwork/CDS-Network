import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordSync } from "@/lib/integration-sync";
import { shipStationRequest, ShipStationError } from "./client";
import { shipStationConfig } from "./config";
import {
  buildPickupRequest,
  mapPickup,
  pickupContact,
  pickupRefusal,
  pickupWindowText,
  stateFromSummary,
  validatePickupForm,
  zoneForState,
  type PickupForm,
} from "./pickup-requests";

/**
 * Book and cancel a carrier pickup for a real label in use. Callers check requireCds() first
 * and pass the signed-in user's client: reads go through RLS and the pickup is recorded by
 * public.cds_record_shipment_pickup and public.cds_cancel_shipment_pickup.
 */

type Db = SupabaseClient;

export type PickupResult = { ok: true; message: string } | { ok: false; error: string };

function failure(e: unknown): string {
  if (e instanceof ShipStationError) return e.message;
  return e instanceof Error ? e.message : "Unknown error";
}

async function logSync(db: Db, entity: string, shipmentId: string, status: string, externalId: string | null, error: string | null) {
  await recordSync(db, {
    system: "shipstation",
    entity,
    entity_id: shipmentId,
    external_id: externalId,
    direction: "push",
    status,
    error: error ? error.slice(0, 2000) : null,
  });
}

export async function schedulePickupForLabel(db: Db, labelId: string, form: PickupForm, now: Date = new Date()): Promise<PickupResult> {
  const config = shipStationConfig();
  if (!config) return { ok: false, error: "ShipStation is not configured (SHIPSTATION_API_KEY)." };

  const { data: l, error } = await db
    .from("shipment_labels")
    .select("id, shipment_id, shipstation_label_id, is_test, status, ship_from_summary")
    .eq("id", labelId)
    .maybeSingle();
  if (error) return { ok: false, error: "The label could not be read. Try again." };
  if (!l) return { ok: false, error: "Label not found." };
  if (l.status !== "active") return { ok: false, error: "This label is voided." };
  // Never call ShipStation for a test label or while the portal makes test labels.
  const refusal = pickupRefusal(l, config.testLabels);
  if (refusal) return { ok: false, error: refusal };

  const [existing, settings] = await Promise.all([
    db.from("shipment_pickups").select("id", { count: "exact", head: true }).eq("label_id", l.id).eq("status", "scheduled"),
    db.from("shipping_settings").select("from_name, from_company, from_email, from_phone").maybeSingle(),
  ]);
  if (existing.error || settings.error) return { ok: false, error: "The shipping details could not be read. Try again." };
  if ((existing.count ?? 0) > 0) return { ok: false, error: "This label already has a pickup. Cancel it before booking another." };
  const contact = pickupContact(settings.data);
  if (!contact.ok) return contact;

  // The carrier comes to the label's ship-from address; its state gives the local time zone.
  const zone = zoneForState(stateFromSummary(l.ship_from_summary));
  const checked = validatePickupForm(form, zone, now);
  if (!checked.ok) return checked;

  let body;
  try {
    body = buildPickupRequest({ labelId: l.shipstation_label_id, contact: contact.contact, window: checked.window, notes: checked.notes });
  } catch (e) {
    return { ok: false, error: failure(e) };
  }

  let pickup;
  try {
    pickup = mapPickup(await shipStationRequest<unknown>(config.apiKey, "POST", "pickups", { body, timeoutMs: 60_000 }));
  } catch (e) {
    const msg = failure(e);
    await logSync(db, "pickup", l.shipment_id, e instanceof ShipStationError && e.rejected ? "rejected" : "error", l.shipstation_label_id, msg);
    if (e instanceof ShipStationError && !e.rejected) {
      return { ok: false, error: `ShipStation did not answer clearly (${msg}). Check ShipStation for a new pickup before trying again.` };
    }
    return { ok: false, error: `ShipStation refused the pickup: ${msg.replace(/\.$/, "")}.` };
  }

  const { error: rpcError } = await db.rpc("cds_record_shipment_pickup", {
    p_label: l.id,
    p_pickup: {
      shipstation_pickup_id: pickup.pickupId,
      confirmation_number: pickup.confirmationNumber,
      window_start: checked.window.startIso,
      window_end: checked.window.endIso,
      time_zone: checked.window.timeZone,
      notes: checked.notes,
    },
  });
  if (rpcError) {
    const msg = `Pickup ${pickup.pickupId} (confirmation ${pickup.confirmationNumber ?? "none"}) was booked in ShipStation but not saved in the portal: ${rpcError.message}`;
    await logSync(db, "pickup", l.shipment_id, "error", pickup.pickupId, msg);
    return { ok: false, error: `${msg}. Cancel it in ShipStation if it will not be used.` };
  }
  const when = pickupWindowText(checked.window.startIso, checked.window.endIso, checked.window.timeZone);
  return { ok: true, message: `Pickup booked: ${when}${pickup.confirmationNumber ? `, confirmation ${pickup.confirmationNumber}` : ""}.` };
}

export async function cancelPickup(db: Db, pickupId: string): Promise<PickupResult> {
  const { data: p, error } = await db
    .from("shipment_pickups")
    .select("id, shipment_id, shipstation_pickup_id, status")
    .eq("id", pickupId)
    .maybeSingle();
  if (error) return { ok: false, error: "The pickup could not be read. Try again." };
  if (!p) return { ok: false, error: "Pickup not found." };
  if (p.status !== "scheduled") return { ok: false, error: "This pickup is already cancelled." };

  const config = shipStationConfig();
  if (!config) return { ok: false, error: "ShipStation is not configured (SHIPSTATION_API_KEY)." };
  try {
    await shipStationRequest<unknown>(config.apiKey, "DELETE", `pickups/${encodeURIComponent(p.shipstation_pickup_id)}`);
  } catch (e) {
    await logSync(db, "pickup_cancel", p.shipment_id, e instanceof ShipStationError && e.rejected ? "rejected" : "error", p.shipstation_pickup_id, failure(e));
    return { ok: false, error: `ShipStation could not cancel the pickup: ${failure(e)}` };
  }
  const { error: rpcError } = await db.rpc("cds_cancel_shipment_pickup", { p_pickup: p.id });
  if (rpcError) return { ok: false, error: `The pickup was cancelled in ShipStation but not in the portal: ${rpcError.message}` };
  return { ok: true, message: "Pickup cancelled." };
}
