const DEFAULT_NEXT = "/account/password";
const BASE = "https://portal.invalid";

/**
 * The page to open after a sign-in or reset link. Only a path on this site is allowed;
 * anything else (another host, a scheme, backslash tricks, encoded variants) falls back
 * to the set-password page.
 */
export function safeNext(value: string | null): string {
  if (!value) return DEFAULT_NEXT;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return DEFAULT_NEXT;
  }
  for (const candidate of [value, decoded]) {
    if (!candidate.startsWith("/") || candidate.startsWith("//")) return DEFAULT_NEXT;
    if (candidate.includes("\\")) return DEFAULT_NEXT;
    // Browsers drop tabs and newlines inside URLs, which can turn "/\t/x" into "//x".
    if (/[\u0000-\u001f\u007f]/.test(candidate)) return DEFAULT_NEXT;
  }
  try {
    if (new URL(decoded, BASE).origin !== BASE) return DEFAULT_NEXT;
    const url = new URL(value, BASE);
    if (url.origin !== BASE) return DEFAULT_NEXT;
    return url.pathname + url.search + url.hash;
  } catch {
    return DEFAULT_NEXT;
  }
}
