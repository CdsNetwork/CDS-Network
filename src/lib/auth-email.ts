/**
 * Password emails for username logins (src/lib/shop-login.ts), sent by the portal through
 * Resend from the portal's own sender, to the login's recovery email. Supabase cannot send
 * them: the login's auth email is an internal login.invalid address.
 *
 * Not behind PORTAL_EMAILS_ENABLED (that switch is for the status emails to CDS): a shop must
 * always be able to reset its password. Needs RESEND_SEND_API_KEY (or RESEND_RECEIVING_API_KEY,
 * as the status emails). Throws on any failure; the caller logs it or shows it to CDS.
 */
import { PORTAL_FROM } from "@/lib/portal-email";
import { EMAIL_PATTERN, isInternalLoginEmail } from "@/lib/shop-login";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export async function sendAuthEmail(
  to: string,
  email: { subject: string; text: string; html: string },
  deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  if (!EMAIL_PATTERN.test(to) || isInternalLoginEmail(to)) throw new Error("Not a deliverable recovery email.");
  const env = deps.env ?? process.env;
  const apiKey = env.RESEND_SEND_API_KEY?.trim() || env.RESEND_RECEIVING_API_KEY?.trim();
  if (!apiKey) throw new Error("Not sent: neither RESEND_SEND_API_KEY nor RESEND_RECEIVING_API_KEY is set.");

  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(RESEND_EMAILS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: PORTAL_FROM, to: [to], subject: email.subject, text: email.text, html: email.html }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`Resend could not be reached (${e instanceof Error ? e.message : String(e)})`);
  }
  const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!res.ok || !body?.id) {
    throw new Error(`Resend answered HTTP ${res.status}${body?.message ? `: ${String(body.message).slice(0, 300)}` : ""}`);
  }
  return body.id;
}
