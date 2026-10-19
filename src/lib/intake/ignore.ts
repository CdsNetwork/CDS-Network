/**
 * Emails at the CDS inboxes that are not new work requests, recognised without the AI stage:
 * replies and forwards on existing threads, shop invoices and payment requests, carrier
 * notices, Google security alerts, Ryder PO paperwork, and CDS's own outgoing mail. Checked
 * after the request templates, so a template email is never ignored.
 */
import { CDS_SENDERS } from "./config";
import { emailAddress, emailDomain } from "./email";
import type { IgnoreKind, NormalizedEmail } from "./types";

export type IgnoreMatch = { kind: IgnoreKind; reason: string; poNumber?: string };

const RYDER_PO = /\bPO\s*#?\s*(\d{10})\s+Issued for\b/i;

const domainIs = (domain: string | null, roots: string[]) => !!domain && roots.some((r) => domain === r || domain.endsWith(`.${r}`));

export function ignoreRule(email: Pick<NormalizedEmail, "from" | "subject" | "inReplyTo">, text: string): IgnoreMatch | null {
  const subject = email.subject.trim();
  const from = emailAddress(email.from);
  const domain = emailDomain(from);
  const fromHeader = email.from.toLowerCase();

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
