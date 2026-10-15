"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { dbMessage, text } from "@/components/cds-admin/server-utils";
import { isUuid } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
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

export async function saveItemMap(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const itemId = text(formData, "catalog_item_id");
  const choice = qboChoice(formData, "qbo_item");
  if (!isUuid(itemId)) return { error: "Choose a catalog item." };
  if (!validChoice(choice)) return { error: "Choose the QuickBooks item (or enter its numeric id and name)." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("qbo_item_map")
    .upsert(
      { catalog_item_id: itemId, qbo_item_id: choice.id, qbo_item_name: choice.name, updated_by: me.id },
      { onConflict: "catalog_item_id" },
    );
  if (error) return { error: dbMessage(error) };
  return done(`Linked to QuickBooks item ${choice.name}.`);
}

export async function removeItemMap(itemId: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(itemId)) return { error: "Mapping not found." };
  const supabase = await createClient();
  const { error } = await supabase.from("qbo_item_map").delete().eq("catalog_item_id", itemId);
  if (error) return { error: dbMessage(error) };
  return done("Item link removed.");
}

// ---------------------------------------------------------------- customer part numbers

export async function saveAlias(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const customerId = text(formData, "customer_id");
  const itemId = text(formData, "catalog_item_id");
  const partNumber = text(formData, "customer_part_number");
  if (!isUuid(customerId)) return { error: "Choose a customer." };
  if (!isUuid(itemId)) return { error: "Choose a catalog item." };
  if (!partNumber) return { error: "Enter the customer's part number." };
  if (partNumber.length > 100) return { error: "Text is too long (max 100 characters)" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("customer_item_aliases")
    .upsert(
      { customer_id: customerId, catalog_item_id: itemId, customer_part_number: partNumber, updated_by: me.id },
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
