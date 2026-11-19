/**
 * Username logins for shops (Ashley, 2026-11-19). Shops with several locations share one
 * email, and Supabase Auth needs a unique email per login, so CDS gives each location a
 * username (default: the shop's name, e.g. "CDS Allentown") and a recovery email that several
 * locations may share (20261120100000_shop_usernames.sql).
 *
 * The auth user of a username login has an internal address under login.invalid. The .invalid
 * top level domain is reserved (RFC 2606, RFC 6761): it never resolves, so no mail can ever be
 * delivered to it or to anyone else through it. The address carries the shop's short code
 * (readable in Supabase) and a random part, so it cannot be guessed from the shop: signing in
 * straight against Supabase with a guessed address is not a way around the portal's own
 * sign in limits. Password links for these logins are mailed by the portal itself to the
 * recovery email, never by Supabase.
 */
import { PORTAL_BASE_URL } from "@/lib/portal-email";

export const INTERNAL_LOGIN_DOMAIN = "login.invalid";

/**
 * Off until CDS turns it on (Ashley, 2026-11-19: CDS first finishes training shops on the
 * current logins). app_settings "shop_username_logins" = {"enabled": true} turns it on; missing
 * or anything else is off. While off, sign in and Forgot password are exactly as before (email
 * only, no username lookup, no limiter) and Admin > Shops cannot create username logins.
 */
export const USERNAME_LOGINS_SETTING_KEY = "shop_username_logins";
export const USERNAME_LOGINS_OFF = "Username logins are off until CDS turns them on.";

export function usernameLoginsEnabled(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { enabled?: unknown }).enabled === true;
}
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 60;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and collapses runs of whitespace to one space. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Null when the (normalized) username is allowed, else what is wrong. Same rules as the database. */
export function usernameError(username: string): string | null {
  if (username.length < USERNAME_MIN) return `Use at least ${USERNAME_MIN} characters for the username.`;
  if (username.length > USERNAME_MAX) return `Use at most ${USERNAME_MAX} characters for the username.`;
  if (!USERNAME_PATTERN.test(username)) return "A username may hold only letters, digits, spaces, dots, dashes and underscores.";
  return null;
}

/** The shop's name with the characters a username cannot hold removed. */
export function suggestUsername(shopName: string): string {
  return normalizeUsername(shopName.replace(/[^A-Za-z0-9._ -]+/g, " ")).slice(0, USERNAME_MAX).trim();
}

/** A sign in value with "@" is an email; anything else is a username (usernames never hold "@"). */
export function looksLikeEmail(login: string): boolean {
  return login.includes("@");
}

/** The internal auth email of a username login: shop-<short code>-<random hex>@login.invalid. */
export function internalLoginEmail(shortCode: string, randomHex: string): string {
  const code = shortCode.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `shop-${code ? `${code}-` : ""}${randomHex.toLowerCase()}@${INTERNAL_LOGIN_DOMAIN}`;
}

export function isInternalLoginEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${INTERNAL_LOGIN_DOMAIN}`);
}

/**
 * Where password links point. Never taken from the request (an Origin or Host header can be
 * forged, and the link carries a sign in token): PORTAL_PUBLIC_URL when set, the production
 * portal on Vercel production, the deployment's own Vercel URL on a preview, else localhost.
 */
export function authLinkBase(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PORTAL_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (env.VERCEL_ENV === "production") return PORTAL_BASE_URL;
  if (env.VERCEL_URL?.trim()) return `https://${env.VERCEL_URL.trim()}`;
  return "http://localhost:3000";
}

/** The link that signs the login in once (/auth/confirm) and opens the set password page. */
export function passwordLink(base: string, hashedToken: string): string {
  const q = new URLSearchParams({ token_hash: hashedToken, type: "recovery", next: "/account/password" });
  return `${base}/auth/confirm?${q.toString()}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The set password ("welcome", a new login) or reset email to the recovery address. It names
 * the username and the shop, so an inbox shared by several locations knows which one it is for.
 */
export function buildShopPasswordEmail(
  kind: "welcome" | "reset",
  d: { username: string; shopName: string | null; link: string },
): { subject: string; text: string; html: string } {
  const welcome = kind === "welcome";
  const subject = `${welcome ? "Set" : "Reset"} your CDS portal password: ${d.username}`;
  const intro = welcome
    ? "CDS set up a login to the CDS Network Portal for this location. Choose its password with the link below."
    : "Someone asked to reset the password of this CDS Network Portal login. Choose a new password with the link below.";
  const rows: [string, string][] = [["Username", d.username]];
  if (d.shopName?.trim()) rows.push(["Shop", d.shopName.trim()]);
  const after = welcome
    ? "Then sign in with the username and that password."
    : "If you did not ask for this, ignore this email: the password stays as it is.";
  const expiry =
    "The link works once and expires after a while. If it has expired, open the portal's sign in page, choose Forgot password and enter the username.";
  const footer = "Sent by the CDS Network Portal.";

  const text = [intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", d.link, "", after, expiry, "", footer, ""].join("\n");
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    `<table cellpadding="4" cellspacing="0" style="border-collapse:collapse">`,
    ...rows.map(([k, v]) => `<tr><td style="color:#555">${escapeHtml(k)}</td><td><b>${escapeHtml(v)}</b></td></tr>`),
    `</table>`,
    `<p><a href="${escapeHtml(d.link)}">${welcome ? "Set the password" : "Reset the password"}</a></p>`,
    `<p>${escapeHtml(after)}</p>`,
    `<p style="color:#555">${escapeHtml(expiry)}</p>`,
    `<p style="color:#777;font-size:12px">${escapeHtml(footer)}</p>`,
  ].join("\n");
  return { subject, text, html };
}
