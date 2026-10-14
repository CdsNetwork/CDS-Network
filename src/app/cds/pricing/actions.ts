"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { dbMessage, optionalAmount, text } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function setOverride(
  customerId: string,
  itemId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireCds();
  const clear = text(formData, "intent") === "clear";
  const amount = clear ? null : optionalAmount(formData, "amount");
  if (Number.isNaN(amount)) return { error: "Enter a price of zero or more." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("cds_set_price", {
    p_kind: "override",
    p_catalog_item: itemId,
    p_customer: customerId,
    p_amount: amount,
  });
  if (error) return { error: dbMessage(error, "Could not save the price.") };
  revalidatePath("/cds/pricing");
  return { ok: true, message: amount === null ? "Override cleared." : "Saved." };
}
