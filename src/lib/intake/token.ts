import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant time comparison of a presented token with the configured one. Both sides are
 * hashed first so the comparison does not leak the token's length either.
 */
export function tokenMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The token from `Authorization: Bearer <token>` or the `x-intake-token` header. */
export function presentedToken(headers: Headers): string | null {
  const auth = headers.get("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || headers.get("x-intake-token")?.trim() || null;
}
