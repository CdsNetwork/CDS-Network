"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { passwordResetFlow, signInFlow, type RateLimiter, type UsernameLogin } from "@/lib/login-flow";
import { safeNext } from "@/lib/safe-next";
import { usernameLoginsOnForVisitors } from "@/lib/shop-login-setting";
import { createClient } from "@/lib/supabase/server";

export type FormState = { error?: string; message?: string };

/**
 * The service role client for the username lookup and the sign in limits, or null when it
 * cannot be made (then the limits are skipped and logged, and usernames are not found).
 */
async function serviceClient(): Promise<SupabaseClient | null> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    return createAdminClient();
  } catch (e) {
    console.error(`Sign in: no service role client (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

async function loginHelpers(admin: SupabaseClient | null): Promise<{
  limiter: RateLimiter;
  findUsernameLogin(username: string): Promise<UsernameLogin | null>;
}> {
  if (!admin) {
    return {
      limiter: { check: async () => Promise.reject(new Error("no service role client")) },
      findUsernameLogin: async () => null,
    };
  }
  const { databaseRateLimiter, findUsernameLogin } = await import("@/lib/shop-login-server");
  return { limiter: databaseRateLimiter(admin), findUsernameLogin: (u) => findUsernameLogin(admin, u) };
}

/** The caller's IP as Vercel gives it (it sets these headers itself), or null. */
async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

/**
 * Signs in with an email, or with a username while username logins are on
 * (src/lib/login-flow.ts; off: exactly the email sign in from before).
 */
export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const login = String(formData.get("login") ?? formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const on = await usernameLoginsOnForVisitors();

  const supabase = await createClient();
  const helpers = on ? await loginHelpers(await serviceClient()) : await loginHelpers(null);
  const result = await signInFlow(
    { login, password, ip: await clientIp() },
    {
      usernameLogins: on,
      ...helpers,
      signInWithPassword: async (email, pw) => !(await supabase.auth.signInWithPassword({ email, password: pw })).error,
    },
  );
  if ("error" in result) return { error: result.error };
  // next comes from links such as the QuickBooks launch and connect URLs; only portal paths.
  redirect(safeNext(String(formData.get("next") ?? "") || null, "/"));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Forgot password with an email (Supabase's reset email, as before) or, while username logins
 * are on, a username (the
 * portal's reset email to the login's recovery address, sent after the answer so its timing
 * does not tell whether the username exists). The answer is the same in every case.
 */
export async function requestPasswordReset(_prev: FormState, formData: FormData): Promise<FormState> {
  const login = String(formData.get("login") ?? formData.get("email") ?? "");
  const origin = (await headers()).get("origin") ?? "";
  const on = await usernameLoginsOnForVisitors();
  const supabase = await createClient();
  const admin = on ? await serviceClient() : null;
  const helpers = await loginHelpers(admin);

  return passwordResetFlow(
    { login, ip: await clientIp() },
    {
      usernameLogins: on,
      ...helpers,
      // As before: in the request (the Supabase client may set its PKCE cookie). Supabase
      // checks redirectTo against its allowed redirect URLs and answers the same either way.
      sendSupabaseReset: async (email) => {
        await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/confirm?next=/account/password` });
      },
      sendUsernameReset: async (found) => {
        if (!admin) throw new Error("no service role client");
        after(async () => {
          try {
            const { sendShopPasswordEmail } = await import("@/lib/shop-login-server");
            await sendShopPasswordEmail(admin, found, "reset");
          } catch (e) {
            console.error(`Password reset (username login): ${e instanceof Error ? e.message : String(e)}`);
          }
        });
      },
    },
  );
}

export async function setPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 10) return { error: "Use at least 10 characters." };
  if (password !== confirm) return { error: "The two passwords do not match." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?reason=signed-out");
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };
  redirect("/");
}
