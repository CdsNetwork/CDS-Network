import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  full_name: string;
  email: string;
  kind: "cds" | "shop";
  affiliate_id: string | null;
  active: boolean;
  affiliate_name: string | null;
};

/** The signed-in auth user, or null. Cached per request. */
const getUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/** The signed-in user's profile, or null. Cached per request. */
export const getProfile = cache(async (): Promise<Profile | null> => {
  const user = await getUser();
  if (!user) return null;
  const supabase = await createClient();

  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email, kind, affiliate_id, active, affiliates(display_name)")
    .eq("id", user.id)
    .maybeSingle();
  if (!data || !data.active) return null;

  const affiliate = data.affiliates as unknown as { display_name: string } | null;
  return {
    id: data.id,
    full_name: data.full_name,
    email: data.email,
    kind: data.kind,
    affiliate_id: data.affiliate_id,
    active: data.active,
    affiliate_name: affiliate?.display_name ?? null,
  };
});

/** Sends a caller without a usable profile to /login: signed out, or no access. */
async function toLogin(): Promise<never> {
  redirect((await getUser()) ? "/login?reason=no-access" : "/login?reason=signed-out");
}

export async function requireCds(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) return toLogin();
  if (profile.kind !== "cds") redirect("/shop");
  return profile;
}

export async function requireShop(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) return toLogin();
  if (profile.kind !== "shop") redirect("/cds");
  return profile;
}
