"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { checkbox, dbMessage, optionalAmount, optionalText, text } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { CATEGORY_LABEL } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

const TAX_CLASSES = ["parts", "labor", "shipping", "exempt"];

export async function saveCatalogItem(id: string | null, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  const item = {
    sku: text(formData, "sku").toUpperCase(),
    category: text(formData, "category"),
    name: text(formData, "name"),
    oe_cross: optionalText(formData, "oe_cross"),
    tax_class: text(formData, "tax_class"),
    shop_selectable: checkbox(formData, "shop_selectable"),
    active: checkbox(formData, "active"),
  };
  if (!item.sku || !item.name) return { error: "SKU and description are required." };
  if (!(item.category in CATEGORY_LABEL)) return { error: "Choose a category." };
  if (!TAX_CLASSES.includes(item.tax_class)) return { error: "Choose a tax class." };
  const shopRate = optionalAmount(formData, "shop_rate");
  const fleetPrice = optionalAmount(formData, "fleet_price");
  if (Number.isNaN(shopRate) || Number.isNaN(fleetPrice)) return { error: "Prices must be numbers of zero or more." };

  const supabase = await createClient();
  let itemId = id;
  if (id) {
    const { error } = await supabase.from("catalog_items").update(item).eq("id", id);
    if (error) return { error: error.code === "23505" ? "Another item already uses that SKU." : dbMessage(error) };
  } else {
    const { data, error } = await supabase.from("catalog_items").insert(item).select("id").single();
    if (error || !data) {
      return { error: error?.code === "23505" ? "An item with that SKU already exists." : dbMessage(error) };
    }
    itemId = data.id as string;
  }

  const { error: rateError } = await supabase.rpc("cds_set_price", {
    p_kind: "shop_rate",
    p_catalog_item: itemId,
    p_customer: null,
    p_amount: shopRate,
  });
  const { error: fleetError } = await supabase.rpc("cds_set_price", {
    p_kind: "fleet",
    p_catalog_item: itemId,
    p_customer: null,
    p_amount: fleetPrice,
  });
  revalidatePath("/cds/catalog");
  revalidatePath("/cds/pricing");
  if (rateError || fleetError) {
    const which = rateError ? "Shop Rate" : "Fleet Price";
    return { error: `The item was saved, but the ${which} was not: ${dbMessage(rateError ?? fleetError)}` };
  }
  return { ok: true, message: id ? "Item saved." : `${item.sku} added.` };
}

/**
 * Sets or clears the Shop Rate of an item for one customer (any shop), from today. With no
 * customer chosen ("All customers") it sets the default Shop Rate, like the item form.
 * `customerId` is bound for a row's Clear button; the add form sends `customer`.
 */
export async function setCustomerShopRate(
  itemId: string,
  customerId: string | null,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireCds();
  const clear = text(formData, "intent") === "clear";
  const customer = customerId ?? optionalText(formData, "customer");
  const amount = clear ? null : optionalAmount(formData, "amount");
  if (Number.isNaN(amount)) return { error: "Enter a rate of zero or more." };
  if (!clear && amount === null) return { error: "Enter a rate." };
  if (clear && !customer) return { error: "Choose a customer." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("cds_set_price", {
    p_kind: "shop_rate",
    p_catalog_item: itemId,
    p_customer: customer,
    p_amount: amount,
  });
  if (error) return { error: dbMessage(error, "Could not save the rate.") };
  revalidatePath("/cds/catalog");
  revalidatePath("/cds/pricing");
  return { ok: true, message: clear ? "Customer rate removed." : "Rate saved." };
}
