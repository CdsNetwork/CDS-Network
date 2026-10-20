const DEFAULT_NEXT = "/account/password";
const BASE = "https://portal.invalid";
const BASE_ORIGIN = new URL(BASE).origin;
/** Longer values are refused outright; no portal link comes close. */
const MAX_LENGTH = 2048;
/** How many rounds of percent decoding are inspected before the value must be stable. */
const MAX_DECODES = 5;

/**
 * The page to open after a sign-in or reset link. Only a path on this site is allowed;
 * anything else (another host, a scheme, backslash tricks, dot segments, encoded or
 * double encoded variants, control characters) falls back to `fallback` (the
 * set-password page unless given). The result is the pathname, search and hash of the
 * value parsed against a fixed origin, and is checked again after that normalisation,
 * because "/.//x" or "/%2e%2e//x" normalise to the protocol relative "//x".
 */
export function safeNext(value: string | null, fallback: string = DEFAULT_NEXT): string {
  if (!value || value.length > MAX_LENGTH) return fallback;

  const stages = decodeStages(value);
  if (!stages || !stages.every(isSafeStage)) return fallback;

  let result: string;
  try {
    const url = new URL(value, BASE);
    if (url.origin !== BASE_ORIGIN) return fallback;
    result = url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }

  // The normalised result must pass the same checks, and still resolve to this site.
  const resultStages = decodeStages(result);
  if (!resultStages || !resultStages.every(isSafeStage)) return fallback;
  try {
    if (new URL(result, BASE).origin !== BASE_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return result;
}

/** The value and each percent decoded form of it, until decoding changes nothing. */
function decodeStages(value: string): string[] | null {
  const stages = [value];
  let current = value;
  for (let i = 0; i < MAX_DECODES; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) return stages;
    stages.push(decoded);
    current = decoded;
  }
  return null; // still changing after MAX_DECODES rounds
}

function isSafeStage(candidate: string): boolean {
  // A single leading slash: not "//x" (protocol relative) nor "/\x" (browsers read it as "//x").
  if (!/^\/(?![/\\])/.test(candidate)) return false;
  if (candidate.includes("\\")) return false;
  // Browsers drop tabs and newlines inside URLs, which can turn "/\t/x" into "//x".
  if (/[\u0000-\u001f\u007f-\u009f]/.test(candidate)) return false;
  // The path itself: printable ASCII only, no ":" (scheme like) and no "@" (userinfo like).
  const path = candidate.split(/[?#]/, 1)[0];
  if (!/^[\x21-\x7e]*$/.test(path) || /[:@]/.test(path)) return false;
  // Dot segments must not normalise into a protocol relative path.
  try {
    const url = new URL(candidate, BASE);
    if (url.origin !== BASE_ORIGIN || url.pathname.startsWith("//")) return false;
  } catch {
    return false;
  }
  return true;
}
