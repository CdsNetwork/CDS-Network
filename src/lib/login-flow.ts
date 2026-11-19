/**
 * Sign in and Forgot password with an email or a username (src/lib/shop-login.ts), without
 * the database or Supabase so they can be tested (src/app/login/actions.ts wires them).
 *
 * Neither says whether a username exists: an unknown username gets the same answer as a wrong
 * password (and still goes to Supabase, with an address that has no login, as an unknown email
 * does), and Forgot password always gives the same message. Its emails are sent after the
 * answer (the action passes senders that run after the response), so the time to answer does
 * not tell either.
 *
 * Limits (public.auth_rate_limit, keys hashed): sign in refuses for 15 minutes after 10 failed
 * attempts for one email or username, or 30 from one IP address; Forgot password sends nothing
 * after 5 requests in an hour for one email or username, or 20 from one IP (same message).
 * A limit for a username that does not exist works the same as for one that does. If the
 * limiter cannot be reached, sign in goes on (Supabase keeps its own limits) and it is logged.
 */
import { createHash } from "node:crypto";
import { INTERNAL_LOGIN_DOMAIN, isInternalLoginEmail, looksLikeEmail, normalizeUsername } from "@/lib/shop-login";

export const SIGN_IN_ERROR = "Email, username or password is not correct.";
export const RATE_LIMITED_ERROR = "Too many sign in attempts. Wait 15 minutes and try again, or reset your password.";
export const RESET_MESSAGE = "If that email or username has a login, a reset link is on its way.";
/** While username logins are off (src/lib/shop-login.ts): the messages from before them. */
export const OFF_SIGN_IN_ERROR = "Email or password is not correct.";
export const OFF_RESET_MESSAGE = "If that email has a login, a reset link is on its way.";

const SIGN_IN_WINDOW = 15 * 60;
const SIGN_IN_PER_LOGIN = 10;
const SIGN_IN_PER_IP = 30;
const RESET_WINDOW = 60 * 60;
const RESET_PER_LOGIN = 5;
const RESET_PER_IP = 20;

/** The address used to ask Supabase when a username has no login: it has no auth user. */
const NO_LOGIN_EMAIL = `no-login@${INTERNAL_LOGIN_DOMAIN}`;

export type RateLimiter = {
  /** True when the key already has `limit` attempts in the window; records this one when `record`. */
  check(key: string, limit: number, windowSeconds: number, record: boolean): Promise<boolean>;
};

export type UsernameLogin = {
  /** The internal auth email. */
  email: string;
  username: string;
  recoveryEmail: string;
  shopName: string | null;
  active: boolean;
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const loginKey = (scope: string, login: string) => `${scope}:login:${hash(login.toLowerCase())}`;
const ipKey = (scope: string, ip: string | null) => (ip ? `${scope}:ip:${hash(ip)}` : null);

async function anyOver(limiter: RateLimiter, checks: [string | null, number, number][], record: boolean): Promise<boolean> {
  try {
    const results = await Promise.all(
      checks.filter((c): c is [string, number, number] => c[0] !== null).map(([k, limit, w]) => limiter.check(k, limit, w, record)),
    );
    return results.some(Boolean);
  } catch (e) {
    console.error(`Sign in limit could not be checked: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** The sign in value as it is matched: an email trimmed, a username trimmed with single spaces. */
function cleanLogin(raw: string): string {
  const trimmed = raw.trim();
  return looksLikeEmail(trimmed) ? trimmed : normalizeUsername(trimmed);
}

export async function signInFlow(
  input: { login: string; password: string; ip: string | null },
  deps: {
    /** The shop_username_logins switch. Off: the email sign in from before, unchanged. */
    usernameLogins: boolean;
    limiter: RateLimiter;
    findUsernameLogin(username: string): Promise<UsernameLogin | null>;
    /** True when Supabase signed the user in. */
    signInWithPassword(email: string, password: string): Promise<boolean>;
  },
): Promise<{ ok: true } | { error: string }> {
  if (!deps.usernameLogins) {
    const email = input.login.trim();
    if (!email || !input.password) return { error: "Enter your email and password." };
    return (await deps.signInWithPassword(email, input.password)) ? { ok: true } : { error: OFF_SIGN_IN_ERROR };
  }
  const login = cleanLogin(input.login);
  if (!login || !input.password) return { error: "Enter your email or username and your password." };

  const checks: [string | null, number, number][] = [
    [loginKey("signin", login), SIGN_IN_PER_LOGIN, SIGN_IN_WINDOW],
    [ipKey("signin", input.ip), SIGN_IN_PER_IP, SIGN_IN_WINDOW],
  ];
  if (await anyOver(deps.limiter, checks, false)) return { error: RATE_LIMITED_ERROR };

  let email = login;
  if (!looksLikeEmail(login)) {
    const found = await deps.findUsernameLogin(login).catch((e) => {
      console.error(`Username lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    email = found?.email ?? NO_LOGIN_EMAIL;
  }
  if (await deps.signInWithPassword(email, input.password)) return { ok: true };

  await anyOver(deps.limiter, checks, true);
  return { error: SIGN_IN_ERROR };
}

export async function passwordResetFlow(
  input: { login: string; ip: string | null },
  deps: {
    /** The shop_username_logins switch. Off: the email reset from before, unchanged. */
    usernameLogins: boolean;
    limiter: RateLimiter;
    findUsernameLogin(username: string): Promise<UsernameLogin | null>;
    /** Supabase's own reset email for an email login (today's flow). */
    sendSupabaseReset(email: string): Promise<void>;
    /** The portal's reset email to the recovery address of a username login. */
    sendUsernameReset(login: UsernameLogin): Promise<void>;
  },
): Promise<{ message: string } | { error: string }> {
  if (!deps.usernameLogins) {
    const email = input.login.trim();
    if (!email) return { error: "Enter your email." };
    await deps.sendSupabaseReset(email);
    return { message: OFF_RESET_MESSAGE };
  }
  const login = cleanLogin(input.login);
  if (!login) return { error: "Enter your email or username." };

  const checks: [string | null, number, number][] = [
    [loginKey("reset", login), RESET_PER_LOGIN, RESET_WINDOW],
    [ipKey("reset", input.ip), RESET_PER_IP, RESET_WINDOW],
  ];
  if (await anyOver(deps.limiter, checks, true)) return { message: RESET_MESSAGE };

  try {
    if (looksLikeEmail(login)) {
      // An internal address can never receive mail: Supabase is never asked to send to one.
      if (!isInternalLoginEmail(login)) await deps.sendSupabaseReset(login);
    } else {
      const found = await deps.findUsernameLogin(login);
      if (found?.active) await deps.sendUsernameReset(found);
    }
  } catch (e) {
    console.error(`Password reset: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { message: RESET_MESSAGE };
}
