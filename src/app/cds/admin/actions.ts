"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { checkbox, dbMessage, optionalText, text, triState } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { FULFILLMENT_LABEL } from "@/lib/format";
import { LOCATION_SYNC_OFF } from "@/lib/qbo/location-sync";
import { syncLocationsFromQuickBooks } from "@/lib/qbo/location-sync-server";
import { internalLoginEmail, isInternalLoginEmail, normalizeUsername, USERNAME_LOGINS_OFF, usernameError } from "@/lib/shop-login";
import { sendShopPasswordEmail } from "@/lib/shop-login-server";
import { usernameLoginsOn } from "@/lib/shop-login-setting";
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
  if (!EMAIL.test(email) || isInternalLoginEmail(email)) return { error: "Enter a valid email address." };

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

/**
 * "Email this shop about its jobs" (Sarah, CDS, 2026-11-19): notices and reminders go to the
 * shop's dispatch contacts only while this is on (20261120200000_shop_emails.sql). Reminders
 * count from when it was turned on. The database refuses it for CDS's in-house shop.
 */
export async function setShopEmails(id: string, enabled: boolean): Promise<ActionState> {
  await requireCds();
  const supabase = await createClient();
  const { error } = await supabase.from("affiliates").update({ shop_emails_enabled: enabled }).eq("id", id);
  if (error) return { error: dbMessage(error) };
  return done(enabled ? "Emails to this shop turned on." : "Emails to this shop turned off.");
}

export async function inviteShopLogin(affiliateId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const existing = await activeShopLogin(affiliateId);
  if (existing) return { error: `This shop already has a login (${existing}).` };
  return invite(text(formData, "full_name"), text(formData, "email").toLowerCase(), "shop", affiliateId);
}

/** The username or email of the shop's active login, or null when it has none. */
async function activeShopLogin(affiliateId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("email, username")
    .eq("kind", "shop")
    .eq("affiliate_id", affiliateId)
    .eq("active", true)
    .maybeSingle();
  return data ? String(data.username ?? data.email) : null;
}

const USERNAME_TAKEN = "That username is already used by another login (perhaps a deactivated one). Choose another.";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

function recoveryEmailError(email: string): string | null {
  return EMAIL.test(email) && !isInternalLoginEmail(email) ? null : "Enter a valid recovery email.";
}

/**
 * A username login for a shop (Ashley, 2026-11-19; src/lib/shop-login.ts): for shops whose
 * locations share one email. The auth user gets an internal login.invalid address and a long
 * random password nobody sees; the portal emails a one-time link to the recovery email, where
 * the shop chooses its own password. CDS never knows it. Refused while username logins are off
 * (app_settings shop_username_logins).
 */
export async function createShopUsernameLogin(affiliateId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  if (!(await usernameLoginsOn(await createClient()))) return { error: USERNAME_LOGINS_OFF };
  const username = normalizeUsername(text(formData, "username"));
  const recoveryEmail = text(formData, "recovery_email").toLowerCase();
  const badName = usernameError(username);
  if (badName) return { error: badName };
  const badEmail = recoveryEmailError(recoveryEmail);
  if (badEmail) return { error: badEmail };

  const supabase = await createClient();
  const { data: shop } = await supabase.from("affiliates").select("id, short_code, display_name").eq("id", affiliateId).maybeSingle();
  if (!shop) return { error: "Shop not found." };
  const existing = await activeShopLogin(affiliateId);
  if (existing) return { error: `This shop already has a login (${existing}). Deactivate it first.` };
  // citext: matched in any case. The unique index catches one taken at the same moment.
  const { data: taken } = await supabase.from("profiles").select("id").eq("username", username).maybeSingle();
  if (taken) return { error: USERNAME_TAKEN };

  const admin = createAdminClient();
  const email = internalLoginEmail(String(shop.short_code), randomBytes(8).toString("hex"));
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: randomBytes(32).toString("base64url"),
    email_confirm: true,
    user_metadata: { full_name: username },
  });
  if (error || !data.user) return { error: "The login could not be created. Try again." };

  const { error: profileError } = await supabase.from("profiles").insert({
    id: data.user.id,
    full_name: username,
    email,
    kind: "shop",
    affiliate_id: affiliateId,
    username,
    recovery_email: recoveryEmail,
  });
  if (profileError) {
    await admin.auth.admin.deleteUser(data.user.id);
    if (profileError.code === "23505") {
      return { error: /username/i.test(profileError.message ?? "") ? USERNAME_TAKEN : "This shop already has an active login. Deactivate it first." };
    }
    return { error: dbMessage(profileError, "The login could not be set up. Try again.") };
  }

  try {
    await sendShopPasswordEmail(admin, { email, username, recoveryEmail, shopName: String(shop.display_name) }, "welcome");
  } catch (e) {
    console.error(`Shop login ${data.user.id}: set password email failed: ${errorText(e)}`);
    revalidatePath("/cds/admin");
    return {
      error: `Login ${username} was created, but the email to ${recoveryEmail} could not be sent (${errorText(e)}). Use "Email password link" to try again.`,
    };
  }
  return done(`Login ${username} created. A link to set its password was sent to ${recoveryEmail}.`);
}

/** Emails a new one-time password link of a username login to its recovery email. */
export async function sendShopPasswordLink(profileId: string): Promise<ActionState> {
  await requireCds();
  const supabase = await createClient();
  if (!(await usernameLoginsOn(supabase))) return { error: USERNAME_LOGINS_OFF };
  const { data: p } = await supabase
    .from("profiles")
    .select("id, email, username, recovery_email, active, affiliates(display_name)")
    .eq("id", profileId)
    .maybeSingle();
  if (!p?.username || !p.recovery_email) return { error: "This login signs in with its own email: the shop can use Forgot password." };
  if (!p.active) return { error: "Reactivate the login first." };
  const shop = p.affiliates as unknown as { display_name: string } | null;
  const recoveryEmail = String(p.recovery_email);
  try {
    await sendShopPasswordEmail(
      createAdminClient(),
      { email: String(p.email), username: String(p.username), recoveryEmail, shopName: shop?.display_name ?? null },
      "reset",
    );
  } catch (e) {
    console.error(`Shop login ${profileId}: password email failed: ${errorText(e)}`);
    return { error: `The email could not be sent (${errorText(e)}). Try again.` };
  }
  return done(`A password link for ${String(p.username)} was sent to ${recoveryEmail}.`);
}

/** Changes the recovery email of a username login. */
export async function setShopRecoveryEmail(profileId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const recoveryEmail = text(formData, "recovery_email").toLowerCase();
  const bad = recoveryEmailError(recoveryEmail);
  if (bad) return { error: bad };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ recovery_email: recoveryEmail })
    .eq("id", profileId)
    .not("username", "is", null)
    .select("id");
  if (error) return { error: dbMessage(error) };
  if (!data?.length) return { error: "Only username logins have a recovery email." };
  return done("Recovery email saved.");
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

/**
 * "Sync now" on Admin > Locations: the same QuickBooks location sync the hourly cron runs
 * (src/lib/qbo/location-sync.ts), on the server with the service role after requireCds().
 */
export async function syncLocationsNow(): Promise<ActionState> {
  await requireCds();
  const r = await syncLocationsFromQuickBooks("manual");
  revalidatePath("/cds/admin");
  if (r.status === "skipped") return { error: r.reason === LOCATION_SYNC_OFF ? "QuickBooks location sync is off until CDS turns it on." : r.reason };
  if (r.status === "failed") return { error: `The QuickBooks sync failed: ${r.error ?? "unknown error"}` };
  if (r.status === "dry_run") return { error: "Unexpected dry run." };
  return { ok: true, message: `Synced from QuickBooks: ${r.created} new ${r.created === 1 ? "location" : "locations"}, ${r.linked} linked.` };
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
    .upsert(
      { customer_id: customerId, billing_email: billingEmail || null, charge_shipping: checkbox(formData, "charge_shipping") },
      { onConflict: "customer_id" },
    );
  if (billingError) {
    revalidatePath("/cds/admin");
    return { error: "The customer was saved, but the billing email and shipping setting were not." };
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
