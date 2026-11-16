"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { dbMessage, text } from "@/components/cds-admin/server-utils";
import { isUuid } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { BILL_SETTING_KEY, billSettingValue, parseBillSetting } from "@/lib/qbo/bill";
import { disconnect } from "@/lib/qbo/tokens";
import { createClient } from "@/lib/supabase/server";

function done(message: string): ActionState {
  revalidatePath("/cds/admin");
  return { ok: true, message };
}

/**
 * The QuickBooks record picked in a form: either "<id>::<name>" from the QuickBooks list,
 * or the id and name typed in by hand when QuickBooks is not connected.
 */
function qboChoice(formData: FormData, field: string): { id: string; name: string } | null {
  const picked = text(formData, field);
  if (picked) {
    const at = picked.indexOf("::");
    if (at > 0) return { id: picked.slice(0, at).trim(), name: picked.slice(at + 2).trim() };
  }
  const id = text(formData, `${field}_id`);
  const name = text(formData, `${field}_name`);
  return id && name ? { id, name } : null;
}

function validChoice(choice: { id: string; name: string } | null): choice is { id: string; name: string } {
  // QuickBooks ids are numeric strings.
  return !!choice && /^\d{1,50}$/.test(choice.id) && choice.name.length > 0 && choice.name.length <= 500;
}

// ---------------------------------------------------------------- connection

export async function disconnectQuickBooks(): Promise<ActionState> {
  const me = await requireCds();
  try {
    const { revoked } = await disconnect(me.id);
    return done(
      revoked
        ? "QuickBooks disconnected."
        : "QuickBooks disconnected here. Intuit could not be reached to revoke access; remove the app in QuickBooks too.",
    );
  } catch {
    return { error: "QuickBooks could not be disconnected. Try again." };
  }
}

// ---------------------------------------------------------------- mappings

export async function saveCustomerMap(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const customerId = text(formData, "customer_id");
  const choice = qboChoice(formData, "qbo_customer");
  if (!isUuid(customerId)) return { error: "Choose a portal customer." };
  if (!validChoice(choice)) return { error: "Choose the QuickBooks customer (or enter its numeric id and display name)." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("qbo_customer_map")
    .upsert(
      { customer_id: customerId, qbo_customer_id: choice.id, qbo_display_name: choice.name, updated_by: me.id },
      { onConflict: "customer_id" },
    );
  if (error) return { error: dbMessage(error) };
  return done(`Linked to QuickBooks customer ${choice.name}.`);
}

export async function removeCustomerMap(customerId: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(customerId)) return { error: "Mapping not found." };
  const supabase = await createClient();
  const { error } = await supabase.from("qbo_customer_map").delete().eq("customer_id", customerId);
  if (error) return { error: dbMessage(error) };
  return done("Customer link removed.");
}

/** The optional customer of a mapping: "" means all customers. */
function mappingCustomer(formData: FormData): { ok: true; id: string | null } | { ok: false } {
  const id = text(formData, "customer_id");
  if (!id) return { ok: true, id: null };
  return isUuid(id) ? { ok: true, id } : { ok: false };
}

export async function saveItemMap(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const itemId = text(formData, "catalog_item_id");
  const customer = mappingCustomer(formData);
  const choice = qboChoice(formData, "qbo_item");
  if (!isUuid(itemId)) return { error: "Choose a catalog item." };
  if (!customer.ok) return { error: "Choose a customer, or All customers." };
  if (!validChoice(choice)) return { error: "Choose the QuickBooks item (or enter its numeric id and name)." };
  const supabase = await createClient();
  // One row for all customers and one per customer for each catalog item (nulls not distinct).
  const { error } = await supabase
    .from("qbo_item_map")
    .upsert(
      { customer_id: customer.id, catalog_item_id: itemId, qbo_item_id: choice.id, qbo_item_name: choice.name, updated_by: me.id },
      { onConflict: "customer_id,catalog_item_id" },
    );
  if (error) return { error: dbMessage(error) };
  return done(`Linked to QuickBooks item ${choice.name}${customer.id ? " for this customer" : " for all customers"}.`);
}

export async function removeItemMap(id: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(id)) return { error: "Mapping not found." };
  const supabase = await createClient();
  const { error } = await supabase.from("qbo_item_map").delete().eq("id", id);
  if (error) return { error: dbMessage(error) };
  return done("Item link removed.");
}

// ---------------------------------------------------------------- measurement lines

const COMPONENT_TYPES = ["DPF", "DOC", "SCR", "EGR"] as const;

export async function saveMeasurementMap(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const customer = mappingCustomer(formData);
  const type = text(formData, "component_type");
  const choice = qboChoice(formData, "qbo_item");
  if (!customer.ok) return { error: "Choose a customer, or All customers." };
  if (!(COMPONENT_TYPES as readonly string[]).includes(type)) return { error: "Choose the component type." };
  if (!validChoice(choice)) return { error: "Choose the QuickBooks item (or enter its numeric id and name)." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("qbo_measurement_map")
    .upsert(
      { customer_id: customer.id, component_type: type, qbo_item_id: choice.id, qbo_item_name: choice.name, updated_by: me.id },
      { onConflict: "customer_id,component_type" },
    );
  if (error) return { error: dbMessage(error) };
  return done(`${type} measurement lines use QuickBooks item ${choice.name}${customer.id ? " for this customer" : " for all customers"}.`);
}

export async function removeMeasurementMap(id: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(id)) return { error: "Mapping not found." };
  const supabase = await createClient();
  const { error } = await supabase.from("qbo_measurement_map").delete().eq("id", id);
  if (error) return { error: dbMessage(error) };
  return done("Measurement line mapping removed.");
}

// ---------------------------------------------------------------- customer part numbers

export async function saveAlias(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const customerId = text(formData, "customer_id");
  const itemId = text(formData, "catalog_item_id");
  const partNumber = text(formData, "customer_part_number");
  const description = text(formData, "customer_description");
  if (!isUuid(customerId)) return { error: "Choose a customer." };
  if (!isUuid(itemId)) return { error: "Choose a catalog item." };
  if (!partNumber) return { error: "Enter the customer's part number." };
  if (partNumber.length > 100) return { error: "Text is too long (max 100 characters)" };
  if (description.length > 500) return { error: "Description is too long (max 500 characters)" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("customer_item_aliases")
    .upsert(
      {
        customer_id: customerId,
        catalog_item_id: itemId,
        customer_part_number: partNumber,
        customer_description: description || null,
        updated_by: me.id,
      },
      { onConflict: "customer_id,catalog_item_id" },
    );
  if (error) return { error: dbMessage(error) };
  return done(`Customer part number ${partNumber} saved.`);
}

export async function removeAlias(id: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(id)) return { error: "Part number not found." };
  const supabase = await createClient();
  const { error } = await supabase.from("customer_item_aliases").delete().eq("id", id);
  if (error) return { error: dbMessage(error) };
  return done("Customer part number removed.");
}

// ---------------------------------------------------------------- shop bills

/** Links a shop to its QuickBooks vendor (picked from the list, or the suggested one). */
async function linkVendor(affiliateId: string, choice: { id: string; name: string } | null): Promise<ActionState> {
  const me = await requireCds();
  if (!isUuid(affiliateId)) return { error: "Choose a shop." };
  if (!validChoice(choice)) return { error: "Choose the QuickBooks vendor (or enter its numeric id and name)." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("qbo_affiliate_vendor")
    .upsert({ affiliate_id: affiliateId, qbo_vendor_id: choice.id, qbo_vendor_name: choice.name, updated_by: me.id }, { onConflict: "affiliate_id" });
  if (error) return { error: dbMessage(error) };
  return done(`Linked to QuickBooks vendor ${choice.name}.`);
}

export async function saveVendorMap(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return linkVendor(text(formData, "affiliate_id"), qboChoice(formData, "qbo_vendor"));
}

export async function linkSuggestedVendor(affiliateId: string, vendorId: string, vendorName: string): Promise<ActionState> {
  return linkVendor(affiliateId, { id: vendorId, name: vendorName });
}

export async function removeVendorMap(affiliateId: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(affiliateId)) return { error: "Link not found." };
  const supabase = await createClient();
  const { error } = await supabase.from("qbo_affiliate_vendor").delete().eq("affiliate_id", affiliateId);
  if (error) return { error: dbMessage(error) };
  return done("Vendor link removed.");
}

/**
 * The one expense account or product/service item every bill line goes to, and optional
 * terms (app_settings qbo_bill_line, see @/lib/qbo/bill). The list value is
 * "account::<id>::<name>" or "item::<id>::<name>"; by hand: kind, id and name. Bills start
 * with the first save: orders completed before then get no automatic bill.
 */
export async function saveBillSetting(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  let kind = text(formData, "bill_kind");
  let choice: { id: string; name: string } | null = null;
  const picked = text(formData, "bill_target");
  if (picked) {
    const [k, id, ...name] = picked.split("::");
    kind = k;
    choice = { id: (id ?? "").trim(), name: name.join("::").trim() };
  } else {
    const id = text(formData, "bill_target_id");
    const name = text(formData, "bill_target_name");
    choice = id && name ? { id, name } : null;
  }
  if (kind !== "account" && kind !== "item") return { error: "Choose an expense account or a product or service item." };
  if (!validChoice(choice)) return { error: "Choose the QuickBooks account or item (or enter its numeric id and name)." };
  const terms = qboChoice(formData, "bill_terms");
  if (terms && !validChoice(terms)) return { error: "Choose the terms from the list, or leave them empty." };

  const supabase = await createClient();
  const { data: current, error: readError } = await supabase.from("app_settings").select("value").eq("key", BILL_SETTING_KEY).maybeSingle();
  if (readError) return { error: dbMessage(readError) };
  const since = parseBillSetting((current as { value: unknown } | null)?.value)?.since ?? new Date().toISOString();
  const value = billSettingValue({ kind, id: choice.id, name: choice.name, termsId: terms?.id ?? null, termsName: terms?.name ?? null, since });
  const { error } = await supabase.from("app_settings").upsert({ key: BILL_SETTING_KEY, value, updated_by: me.id }, { onConflict: "key" });
  if (error) return { error: dbMessage(error) };
  return done(`Bill lines go to QuickBooks ${kind === "account" ? "account" : "item"} ${choice.name}${terms ? `, terms ${terms.name}` : ""}.`);
}
