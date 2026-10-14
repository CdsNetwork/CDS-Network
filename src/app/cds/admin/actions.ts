"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { checkbox, dbMessage, optionalText, text, triState } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { FULFILLMENT_LABEL } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AFFILIATE_KINDS = ["service_shop", "parts_supplier", "cds_owned"];

async function origin(): Promise<string> {
  const h = await headers();
  const fromHeader = h.get("origin");
  if (fromHeader) return fromHeader;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function done(message: string): ActionState {
  revalidatePath("/cds/admin");
  return { ok: true, message };
}

/**
 * Sends a Supabase invite and creates the matching profile. The admin client is used
 * only for the invite itself (and to undo it if the profile cannot be created).
 */
async function invite(
  fullName: string,
  email: string,
  kind: "cds" | "shop",
  affiliateId: string | null,
): Promise<ActionState> {
  if (!fullName) return { error: "Enter the person's full name." };
  if (!EMAIL.test(email)) return { error: "Enter a valid email address." };

  const supabase = await createClient();
  const { data: existing } = await supabase.from("profiles").select("id").eq("email", email).maybeSingle();
  if (existing) return { error: "That email already has a portal login." };

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${await origin()}/auth/confirm?next=/account/password`,
    data: { full_name: fullName },
  });
  if (error || !data.user) {
    const exists = error?.code === "email_exists" || /already (been )?registered|already exists/i.test(error?.message ?? "");
    return {
      error: exists
        ? "That email is already registered for a login. Use a different address."
        : "The invite could not be sent. Check the address and try again.",
    };
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .insert({ id: data.user.id, full_name: fullName, email, kind, affiliate_id: affiliateId });
  if (profileError) {
    await admin.auth.admin.deleteUser(data.user.id);
    return {
      error:
        profileError.code === "23505"
          ? "This shop already has an active login. Deactivate it first."
          : dbMessage(profileError, "The login could not be set up, so the invite was withdrawn. Try again."),
    };
  }
  return done(`Invite sent to ${email}.`);
}

// ---------------------------------------------------------------- staff

export async function inviteStaff(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  return invite(text(formData, "full_name"), text(formData, "email").toLowerCase(), "cds", null);
}

export async function setProfileActive(
  profileId: string,
  active: boolean,
): Promise<ActionState> {
  const me = await requireCds();
  if (profileId === me.id && !active) return { error: "You cannot deactivate your own login." };
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ active }).eq("id", profileId);
  if (error) {
    return {
      error: error.code === "23505" ? "This shop already has another active login." : dbMessage(error),
    };
  }
  return done(active ? "Login reactivated." : "Login deactivated.");
}

// ---------------------------------------------------------------- shops

export async function saveShop(id: string | null, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const shop = {
    short_code: text(formData, "short_code").toUpperCase(),
    display_name: text(formData, "display_name"),
    kind: text(formData, "kind"),
    address_line1: optionalText(formData, "address_line1"),
    city: optionalText(formData, "city"),
    region: optionalText(formData, "region")?.toUpperCase() ?? null,
    postal_code: optionalText(formData, "postal_code"),
    can_egr: triState(formData, "can_egr"),
    can_oil_soaked: triState(formData, "can_oil_soaked"),
    can_one_box: triState(formData, "can_one_box"),
    hours_note: optionalText(formData, "hours_note"),
  };
  const dispatchEmail = text(formData, "dispatch_email").toLowerCase();
  if (!shop.short_code || !shop.display_name) return { error: "Short code and name are required." };
  if (!AFFILIATE_KINDS.includes(shop.kind)) return { error: "Choose a shop type." };
  if (dispatchEmail && !EMAIL.test(dispatchEmail)) return { error: "Enter a valid dispatch email." };

  const supabase = await createClient();
  let shopId = id;
  if (id) {
    const { error } = await supabase.from("affiliates").update(shop).eq("id", id);
    if (error) return { error: error.code === "23505" ? "Another shop already uses that short code." : dbMessage(error) };
  } else {
    const { data, error } = await supabase.from("affiliates").insert(shop).select("id").single();
    if (error || !data) {
      return { error: error?.code === "23505" ? "A shop with that short code already exists." : dbMessage(error) };
    }
    shopId = data.id as string;
  }

  // One dispatch contact per shop is managed here.
  const { data: contacts } = await supabase
    .from("affiliate_contacts")
    .select("id, email")
    .eq("affiliate_id", shopId)
    .eq("receives_dispatch", true)
    .order("email")
    .limit(1);
  const contact = contacts?.[0] as { id: string; email: string } | undefined;
  let contactError = null;
  if (dispatchEmail && contact && contact.email !== dispatchEmail) {
    ({ error: contactError } = await supabase.from("affiliate_contacts").update({ email: dispatchEmail }).eq("id", contact.id));
  } else if (dispatchEmail && !contact) {
    ({ error: contactError } = await supabase
      .from("affiliate_contacts")
      .insert({ affiliate_id: shopId, email: dispatchEmail, label: "Dispatch", receives_dispatch: true }));
  } else if (!dispatchEmail && contact) {
    ({ error: contactError } = await supabase.from("affiliate_contacts").delete().eq("id", contact.id));
  }
  if (contactError) {
    revalidatePath("/cds/admin");
    return { error: "The shop was saved, but the dispatch email was not." };
  }
  return done(id ? "Shop saved." : `${shop.display_name} added.`);
}

export async function setShopActive(
  id: string,
  active: boolean,
): Promise<ActionState> {
  await requireCds();
  const supabase = await createClient();
  const { error } = await supabase.from("affiliates").update({ active }).eq("id", id);
  if (error) return { error: dbMessage(error) };
  return done(active ? "Shop activated." : "Shop deactivated. Its login can no longer see jobs.");
}

export async function inviteShopLogin(affiliateId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("profiles")
    .select("email")
    .eq("kind", "shop")
    .eq("affiliate_id", affiliateId)
    .eq("active", true)
    .maybeSingle();
  if (existing) return { error: `This shop already has a login (${existing.email}).` };
  return invite(text(formData, "full_name"), text(formData, "email").toLowerCase(), "shop", affiliateId);
}

// ---------------------------------------------------------------- locations

export async function saveLocation(id: string | null, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const location = {
    customer_id: text(formData, "customer_id"),
    code: text(formData, "code").toUpperCase(),
    location_number: optionalText(formData, "location_number"),
    name: text(formData, "name"),
    address_raw: text(formData, "address_raw"),
    address_line1: optionalText(formData, "address_line1"),
    city: optionalText(formData, "city"),
    region: optionalText(formData, "region")?.toUpperCase() ?? null,
    postal_code: optionalText(formData, "postal_code"),
    default_affiliate_id: optionalText(formData, "default_affiliate_id"),
    fulfillment: text(formData, "fulfillment"),
    dock_note: optionalText(formData, "dock_note"),
    routing_notes: optionalText(formData, "routing_notes"),
    active: checkbox(formData, "active"),
  };
  if (!location.customer_id) return { error: "Choose the customer." };
  if (!location.code || !location.name || !location.address_raw) return { error: "Code, name and address are required." };
  if (!(location.fulfillment in FULFILLMENT_LABEL)) return { error: "Choose a fulfillment method." };

  const supabase = await createClient();
  const { error } = id
    ? await supabase.from("customer_locations").update(location).eq("id", id)
    : await supabase.from("customer_locations").insert(location);
  if (error) {
    return { error: error.code === "23505" ? "This customer already has a location with that code." : dbMessage(error) };
  }
  return done(id ? "Location saved." : `${location.code} added.`);
}

// ---------------------------------------------------------------- customers

export async function saveCustomer(id: string | null, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const customer = {
    code: text(formData, "code").toUpperCase(),
    name: text(formData, "name"),
    active: id ? checkbox(formData, "active") : true,
  };
  const billingEmail = text(formData, "billing_email").toLowerCase();
  if (!customer.code || !customer.name) return { error: "Code and name are required." };
  if (billingEmail && !EMAIL.test(billingEmail)) return { error: "Enter a valid billing email." };

  const supabase = await createClient();
  let customerId = id;
  if (id) {
    const { error } = await supabase.from("customers").update(customer).eq("id", id);
    if (error) return { error: error.code === "23505" ? "Another customer already uses that code." : dbMessage(error) };
  } else {
    const { data, error } = await supabase.from("customers").insert(customer).select("id").single();
    if (error || !data) {
      return { error: error?.code === "23505" ? "A customer with that code already exists." : dbMessage(error) };
    }
    customerId = data.id as string;
  }
  const { error: billingError } = await supabase
    .from("customer_billing")
    .upsert({ customer_id: customerId, billing_email: billingEmail || null }, { onConflict: "customer_id" });
  if (billingError) {
    revalidatePath("/cds/admin");
    return { error: "The customer was saved, but the billing email was not." };
  }
  return done(id ? "Customer saved." : `${customer.name} added.`);
}

// ---------------------------------------------------------------- settings

export async function saveSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const enabled = checkbox(formData, "auto_dispatch_enabled");
  const supabase = await createClient();
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "auto_dispatch_enabled", value: enabled, updated_by: me.id }, { onConflict: "key" });
  if (error) return { error: dbMessage(error) };
  return done("Settings saved.");
}
