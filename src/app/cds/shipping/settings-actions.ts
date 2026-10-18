"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { checkbox, dbMessage, optionalAmount, optionalText, text } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const CARRIERS = ["UPS", "FedEx", "USPS", "Other"];

function done(message: string): ActionState {
  revalidatePath("/cds/shipping");
  return { ok: true, message };
}

/** CDS's ship-from address, phone and the default package. */
export async function saveShippingSettings(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const profile = await requireCds();
  const weight = optionalAmount(fd, "default_weight_lb");
  const dims = ["default_length_in", "default_width_in", "default_height_in"].map((n) => optionalAmount(fd, n));
  if (weight === null || Number.isNaN(weight) || weight <= 0 || weight > 150) return { error: "Default weight must be between 0 and 150 lb." };
  if (dims.some((d) => Number.isNaN(d) || d === 0)) return { error: "Sizes must be numbers above zero, or blank." };
  const country = (optionalText(fd, "country") ?? "US").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { error: "Country is a two letter code, for example US." };
  const row = {
    singleton: true,
    from_name: optionalText(fd, "from_name"),
    from_company: optionalText(fd, "from_company"),
    from_phone: optionalText(fd, "from_phone"),
    from_email: optionalText(fd, "from_email"),
    address_line1: optionalText(fd, "address_line1"),
    address_line2: optionalText(fd, "address_line2"),
    city: optionalText(fd, "city"),
    region: optionalText(fd, "region")?.toUpperCase() ?? null,
    postal_code: optionalText(fd, "postal_code"),
    country,
    default_weight_lb: weight,
    default_length_in: dims[0],
    default_width_in: dims[1],
    default_height_in: dims[2],
    updated_by: profile.id,
  };
  const supabase = await createClient();
  const { error } = await supabase.from("shipping_settings").upsert(row, { onConflict: "singleton" });
  if (error) return { error: dbMessage(error) };
  return done("Shipping settings saved.");
}

/** A ShipStation carrier (for example UPS by Worldwide Express once it is connected). */
export async function addCarrier(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const profile = await requireCds();
  const id = text(fd, "shipstation_carrier_id");
  const carrier = text(fd, "carrier");
  const name = text(fd, "name");
  if (!/^se-[0-9]+$/.test(id)) return { error: "The ShipStation carrier id looks like se-1234567." };
  if (!CARRIERS.includes(carrier)) return { error: "Choose UPS, FedEx, USPS or Other." };
  if (!name) return { error: "Give the carrier a name." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("shipping_carriers")
    .insert({ shipstation_carrier_id: id, carrier, name: name.slice(0, 100), active: checkbox(fd, "active"), sort_order: 10, updated_by: profile.id });
  if (error) return { error: error.code === "23505" ? "That carrier is already on the list." : dbMessage(error) };
  return done("Carrier added.");
}

export async function setCarrierActive(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const profile = await requireCds();
  const supabase = await createClient();
  const { error } = await supabase
    .from("shipping_carriers")
    .update({ active: text(fd, "active") === "true", updated_by: profile.id })
    .eq("id", id);
  if (error) return { error: dbMessage(error) };
  return done("Saved.");
}

export async function addService(carrierId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const profile = await requireCds();
  const code = text(fd, "service_code").toLowerCase();
  const name = text(fd, "name");
  if (!/^[a-z0-9_]{2,80}$/.test(code)) return { error: "Use the ShipStation service code, for example fedex_ground." };
  if (!name) return { error: "Give the service a name." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("shipping_services")
    .insert({ carrier_id: carrierId, service_code: code, name: name.slice(0, 100), updated_by: profile.id });
  if (error) return { error: error.code === "23505" ? "That service is already on the list." : dbMessage(error) };
  return done("Service added.");
}

export async function setServiceActive(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const profile = await requireCds();
  const supabase = await createClient();
  const { error } = await supabase
    .from("shipping_services")
    .update({ active: text(fd, "active") === "true", updated_by: profile.id })
    .eq("id", id);
  if (error) return { error: dbMessage(error) };
  return done("Saved.");
}
