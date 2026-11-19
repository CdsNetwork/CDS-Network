import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendAuthEmail } from "@/lib/auth-email";
import type { RateLimiter, UsernameLogin } from "@/lib/login-flow";
import { authLinkBase, buildShopPasswordEmail, passwordLink } from "@/lib/shop-login";

/**
 * Database side of username logins (src/lib/shop-login.ts). Every function here takes the
 * service role client: the sign in page has no session, and only the service role may look a
 * username up or create a sign in link. Callers never show what these find to the visitor.
 */

/** The login with this username, in any case, active or not; null when there is none. */
export async function findUsernameLogin(admin: SupabaseClient, username: string): Promise<UsernameLogin | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("email, username, recovery_email, active, affiliates(display_name)")
    .eq("username", username)
    .maybeSingle();
  if (error) throw new Error(`Username lookup failed: ${error.message}`);
  if (!data?.username || !data.recovery_email) return null;
  const shop = data.affiliates as unknown as { display_name: string } | null;
  return {
    email: String(data.email),
    username: String(data.username),
    recoveryEmail: String(data.recovery_email),
    shopName: shop?.display_name ?? null,
    active: Boolean(data.active),
  };
}

/**
 * Creates a one-time sign in link for the login (Supabase recovery link; Supabase sends
 * nothing) and emails it to the recovery address. The link opens /auth/confirm, then the set
 * password page. Throws when the link or the email fails.
 */
export async function sendShopPasswordEmail(
  admin: SupabaseClient,
  login: Pick<UsernameLogin, "email" | "username" | "recoveryEmail" | "shopName">,
  kind: "welcome" | "reset",
): Promise<void> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email: login.email });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) throw new Error(`The password link could not be created${error ? `: ${error.message}` : ""}.`);
  const email = buildShopPasswordEmail(kind, {
    username: login.username,
    shopName: login.shopName,
    link: passwordLink(authLinkBase(), hashed),
  });
  await sendAuthEmail(login.recoveryEmail, email);
}

/** public.auth_rate_limit through the service role. */
export function databaseRateLimiter(admin: SupabaseClient): RateLimiter {
  return {
    async check(key, limit, windowSeconds, record) {
      const { data, error } = await admin.rpc("auth_rate_limit", {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
        p_record: record,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
  };
}
