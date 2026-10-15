/**
 * Small crypto helpers for the QuickBooks connection: the signed OAuth state cookie and
 * encryption of the stored tokens. Pure (no Next.js or database), so they are unit tested.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const STATE_COOKIE = "qbo_oauth_state";
/** How long the user has to finish the Intuit consent screen. */
export const STATE_TTL_SECONDS = 600;

function key(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "cds-portal-qbo", purpose, 32));
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", key(secret, "oauth-state")).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * A new OAuth state value and the cookie that proves this browser and this login started
 * the flow: "<state>.<profileId>.<expires>.<signature>".
 */
export function createState(secret: string, profileId: string, now = Date.now()): { state: string; cookie: string } {
  const state = randomBytes(24).toString("base64url");
  const expires = Math.floor(now / 1000) + STATE_TTL_SECONDS;
  const payload = `${state}.${profileId}.${expires}`;
  return { state, cookie: `${payload}.${sign(secret, payload)}` };
}

/** True when the cookie is ours, unexpired, for this login, and matches the state Intuit sent back. */
export function verifyState(
  secret: string,
  cookie: string | undefined,
  state: string | null,
  profileId: string,
  now = Date.now(),
): boolean {
  if (!cookie || !state) return false;
  const parts = cookie.split(".");
  if (parts.length !== 4) return false;
  const [cookieState, cookieProfile, expires, signature] = parts;
  if (!safeEqual(signature, sign(secret, `${cookieState}.${cookieProfile}.${expires}`))) return false;
  if (!safeEqual(cookieState, state)) return false;
  if (cookieProfile !== profileId) return false;
  const exp = Number(expires);
  return Number.isFinite(exp) && exp >= Math.floor(now / 1000);
}

/**
 * Tokens are encrypted (AES-256-GCM) before they are stored, with a key derived from the
 * Intuit client secret: a copy of the database alone does not give access to QuickBooks.
 * A new client secret makes the stored tokens unreadable, and QuickBooks must be connected again.
 */
export function encryptToken(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret, "token"), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptToken(secret: string, stored: string): string {
  const [version, iv, tag, body] = stored.split(".");
  if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("Stored QuickBooks token has an unknown format");
  const decipher = createDecipheriv("aes-256-gcm", key(secret, "token"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
