const DEFAULT_NEXT = "/account/password";
const BASE = "https://portal.invalid";

/**
 * The page to open after a sign-in or reset link. Only a path on this site is allowed;
 * anything else (another host, a scheme, backslash tricks, encoded variants) falls back
 * to `fallback` (the set-password page unless given).
 */
export function safeNext(value: string | null, fallback: string = DEFAULT_NEXT): string {
  if (!value) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  for (const candidate of [value, decoded]) {
    if (!candidate.startsWith("/") || candidate.startsWith("//")) return fallback;
    if (candidate.includes("\\")) return fallback;
    // Browsers drop tabs and newlines inside URLs, which can turn "/\t/x" into "//x".
    if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  }
  try {
    if (new URL(decoded, BASE).origin !== BASE) return fallback;
    const url = new URL(value, BASE);
    if (url.origin !== BASE) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
