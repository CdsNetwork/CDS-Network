/**
 * Authenticity of ShipStation webhooks.
 *
 * ShipStation signs every outgoing webhook with RSA-SHA256
 * (https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks):
 *   * headers x-shipengine-rsa-sha256-key-id, x-shipengine-rsa-sha256-signature (base64)
 *     and x-shipengine-timestamp; a request without them is answered 404;
 *   * the signed bytes are "<timestamp>.<raw request body>";
 *   * the timestamp must be within 5 minutes of now, either way (400 otherwise);
 *   * the public key is the RSA key with that kid in the JWKS at https://api.shipengine.com/jwks
 *     (cached, revalidated with the ETag, refetched for an unknown kid); a bad signature is 401.
 */
import { createPublicKey, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";

export const MAX_SKEW_MS = 5 * 60 * 1000;

export type KeyFinder = (kid: string) => Promise<(JsonWebKey & { kid?: string }) | null>;

export type VerifyResult = { ok: true } | { ok: false; status: 400 | 401 | 404; reason: string };

export async function verifyWebhook(input: {
  headers: Headers;
  rawBody: string;
  now?: Date;
  findKey: KeyFinder;
}): Promise<VerifyResult> {
  const kid = input.headers.get("x-shipengine-rsa-sha256-key-id");
  const signature = input.headers.get("x-shipengine-rsa-sha256-signature");
  const timestamp = input.headers.get("x-shipengine-timestamp");
  if (!kid || !signature || !timestamp) return { ok: false, status: 404, reason: "signature headers missing" };

  const at = Date.parse(timestamp);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(at) || Math.abs(now - at) > MAX_SKEW_MS) {
    return { ok: false, status: 400, reason: "timestamp out of range" };
  }

  let jwk: JsonWebKey | null;
  try {
    jwk = await input.findKey(kid);
  } catch {
    return { ok: false, status: 401, reason: "signing key could not be loaded" };
  }
  if (!jwk) return { ok: false, status: 401, reason: "unknown signing key" };

  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const valid = verify("sha256", Buffer.from(`${timestamp}.${input.rawBody}`), key, Buffer.from(signature, "base64"));
    return valid ? { ok: true } : { ok: false, status: 401, reason: "bad signature" };
  } catch {
    return { ok: false, status: 401, reason: "bad signature" };
  }
}

type Jwk = JsonWebKey & { kid?: string };

/** A key finder over a JWKS URL with an in-memory cache (per server instance). */
export function createJwksKeyFinder(url: string, fetchImpl: typeof fetch = fetch): KeyFinder {
  let keys: Jwk[] | null = null;
  let etag: string | null = null;

  async function load(): Promise<void> {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", ...(etag && keys ? { "If-None-Match": etag } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 304 && keys) return;
    if (!res.ok) throw new Error(`JWKS returned HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    keys = Array.isArray(body.keys) ? body.keys : [];
    etag = res.headers.get("etag");
  }

  const pick = (kid: string) => keys?.find((k) => k.kid === kid && k.kty === "RSA") ?? null;

  return async (kid: string) => {
    if (keys) {
      const hit = pick(kid);
      if (hit) return hit;
    }
    await load();
    return pick(kid);
  };
}

/** Constant time comparison of the optional webhook token. Empty tokens never match. */
export function tokenMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
