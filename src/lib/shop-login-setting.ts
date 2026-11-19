import type { SupabaseClient } from "@supabase/supabase-js";
import { USERNAME_LOGINS_SETTING_KEY, usernameLoginsEnabled } from "@/lib/shop-login";

/**
 * No "server-only" here (the server actions that import it are unit tested); the service role
 * client is loaded only inside usernameLoginsOnForVisitors, from the server-only admin module.
 *
 * Reads the shop_username_logins switch (src/lib/shop-login.ts) with the given client (a CDS
 * login's own client, or the service role). Off when it cannot be read.
 */
export async function usernameLoginsOn(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.from("app_settings").select("value").eq("key", USERNAME_LOGINS_SETTING_KEY).maybeSingle();
  if (error) {
    console.error(`shop_username_logins could not be read: ${error.message}`);
    return false;
  }
  return usernameLoginsEnabled(data?.value);
}

/**
 * The switch for pages without a session (sign in, Forgot password): app_settings is CDS only,
 * so it is read with the service role. Off when that client cannot be made or read.
 */
export async function usernameLoginsOnForVisitors(): Promise<boolean> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    return await usernameLoginsOn(createAdminClient());
  } catch (e) {
    console.error(`shop_username_logins could not be read: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
