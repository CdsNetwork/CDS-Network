/**
 * Emails at the CDS inboxes that are not new work requests, recognised without the AI stage:
 * replies and forwards on existing threads, shop invoices and payment requests, carrier
 * notices, Google security alerts, Ryder PO paperwork, and CDS's own outgoing mail. Checked
 * after the request templates, so a template email is never ignored.
 */
import { PORTAL_DOMAIN, PORTAL_SUBJECT_PREFIX } from "../portal-email";
import { CDS_SENDERS } from "./config";
import { emailAddress, emailDomain, quotedSenders } from "./email";
import type { IgnoreKind, NormalizedEmail } from "./types";

export type IgnoreMatch = { kind: IgnoreKind; reason: string; poNumber?: string };

const RYDER_PO = /\bPO\s*#?\s*(\d{10})\s+Issued for\b/i;

const domainIs = (domain: string | null, roots: string[]) => !!domain && roots.some((r) => domain === r || domain.endsWith(`.${r}`));

const REPLY_PREFIX = /^(?:\s*(?:re|fwd?|fw)\s*:)+\s*/i;
const PORTAL_ADDRESS = new RegExp(`[\\w.+-]+@${PORTAL_DOMAIN.replace(/\./g, "\\.")}\\b`, "i");

/**
 * The portal's own status emails (src/lib/portal-email.ts): sent to dispatch@, which forwards
 * every email into the intake. Gmail's auto-forwarding keeps the original From, so they arrive
 * from portal@in.cds.direct. As a backup, a "[Portal]" subject (also as a reply or forward)
 * with a portal sender quoted in the text is the same email forwarded by hand. Checked before
 * everything else, even when CDS asks to treat an email as a request: it never makes or links
 * a work order.
 */
export function portalEmailRule(email: Pick<NormalizedEmail, "from" | "subject">, text: string): IgnoreMatch | null {
  const from = emailAddress(email.from);
  const reason = "Sent by the portal itself (status email to CDS), not a request.";
  if (emailDomain(from) === PORTAL_DOMAIN) return { kind: "portal_sent", reason };
  const subject = email.subject.replace(REPLY_PREFIX, "");
  if (!subject.startsWith(PORTAL_SUBJECT_PREFIX.trim())) return null;
  const portalSender = quotedSenders(text).some((a) => emailDomain(a) === PORTAL_DOMAIN) || PORTAL_ADDRESS.test(text);
  return portalSender ? { kind: "portal_sent", reason: `${reason} Forwarded by ${from ?? "someone"}.` } : null;
}

export function ignoreRule(email: Pick<NormalizedEmail, "from" | "subject" | "inReplyTo">, text: string): IgnoreMatch | null {
  const subject = email.subject.trim();
  const from = emailAddress(email.from);
  const domain = emailDomain(from);
  const fromHeader = email.from.toLowerCase();

  // Gmail asks the forwarding target (intake@in.cds.direct) to confirm auto-forwarding. Kept as
  // Ignored with the code in the reason, so a CDS admin can read it on the Email Intake page.
  if (from === "forwarding-noreply@google.com" && /Forwarding Confirmation/i.test(subject)) {
    const code = text.match(/Confirmation code:\s*(\d{4,12})/i)?.[1] ?? subject.match(/\(#(\d{4,12})\)/)?.[1] ?? null;
    const inbox = subject.match(/Receive Mail from\s+(\S+@\S+)/i)?.[1] ?? "the forwarding inbox";
    return {
      kind: "forwarding_confirmation",
      reason: code
        ? `Gmail forwarding confirmation for ${inbox}: confirmation code ${code}. Enter it in that Gmail account under Settings > Forwarding and POP/IMAP.`
        : `Gmail forwarding confirmation for ${inbox}: no code found, open the email text.`,
    };
  }

  // CDS writing to shops and suppliers (dispatch@, xpo@), and CDS's own outgoing subjects.
  if (from && (CDS_SENDERS as readonly string[]).includes(from)) {
    return { kind: "cds_sent", reason: `Sent by CDS (${from}), not a request.` };
  }
  if (/^New Cleaning Request:\s*XPO Location\b/i.test(subject) || /^FS Location\b.*\bShipping ORDER\b/i.test(subject)) {
    return { kind: "cds_sent", reason: "CDS's own request to a shop or supplier, not a request." };
  }
  // Without the *** stars it is CDS passing a Ryder job on to a shop.
  if (/^Ryder Location\b.*\bready for pick\s?-?up\b/i.test(subject)) {
    return { kind: "cds_sent", reason: "CDS's own pick up notice to a shop, not a request." };
  }

  const po = subject.match(RYDER_PO) ?? (/\bRyder Purchase Order\b/i.test(`${subject} ${fromHeader}`) ? text.match(RYDER_PO) : null);
  if (po || /^Ryder Purchase Order\b/i.test(subject)) {
    return { kind: "ryder_po", reason: "Ryder PO paperwork for a job, not a new request.", ...(po ? { poNumber: po[1] } : {}) };
  }

  if (/^(?:re|fwd?|fw)\s*:/i.test(subject) || email.inReplyTo) {
    return { kind: "reply", reason: "Reply or forward on an existing thread, not a new request." };
  }

  if (
    /\bAccepted For Processing\s*:\s*Invoice\b/i.test(subject) ||
    /^Invoice\s*:?\s*[\w-]*\d[\w-]*\s*\|/i.test(subject) ||
    /\bInvoice\b.*\bfrom\b/i.test(subject) ||
    /\bnew payment request\b|\bpayment request from\b/i.test(subject) ||
    /\b(?:quickbooks|intuit)\b/i.test(fromHeader) ||
    /^(?:invoice|statement)\b/i.test(subject)
  ) {
    return { kind: "invoice", reason: "Invoice or payment request, not a request." };
  }

  if (
    domainIs(domain, ["wwex.com", "worldwideexpress.com", "ups.com", "roadie.com"]) ||
    /\bworldwide express\b|\bwwex\b|\broadie\b/i.test(`${subject} ${fromHeader}`) ||
    /\bUPS\b.*\b(?:delivered|delivery|shipment|exception|update|package)\b/i.test(subject) ||
    /^ups\b/i.test(fromHeader.replace(/^"/, ""))
  ) {
    return { kind: "carrier", reason: "Carrier notice, not a request." };
  }

  if (from === "no-reply@accounts.google.com" || /^security alert\b/i.test(subject)) {
    return { kind: "security", reason: "Google security alert, not a request." };
  }
  return null;
}
