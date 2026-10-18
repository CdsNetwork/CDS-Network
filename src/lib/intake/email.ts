import { createHash } from "node:crypto";
import type { EmailAttachment, NormalizedEmail } from "./types";

/** Limits for one stored email. Longer bodies are cut, never rejected. */
export const MAX_BODY_CHARS = 200_000;
const MAX_SUBJECT = 1000;
const MAX_ADDRESS = 500;
const MAX_ATTACHMENTS = 50;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Checks a JSON body against the normalized email shape. Unknown keys are ignored (feeds
 * add their own), missing optional keys get defaults. Accepts `to` as a string or a list.
 */
export function validateNormalizedEmail(input: unknown): Result<NormalizedEmail> {
  if (!isObject(input)) return { ok: false, error: "body must be a JSON object" };
  const messageId = str(input.messageId, 998);
  if (!messageId) return { ok: false, error: "messageId is required" };
  const from = str(input.from, MAX_ADDRESS);
  if (!from) return { ok: false, error: "from is required" };

  const rawTo = Array.isArray(input.to) ? input.to : typeof input.to === "string" ? input.to.split(",") : [];
  const to = rawTo.map((t) => str(t, MAX_ADDRESS)).filter((t): t is string => !!t).slice(0, 50);

  const receivedRaw = input.receivedAt ?? null;
  let receivedAt = new Date().toISOString();
  if (receivedRaw !== null && receivedRaw !== undefined) {
    const d = typeof receivedRaw === "string" ? new Date(receivedRaw) : null;
    if (!d || Number.isNaN(d.getTime())) return { ok: false, error: "receivedAt must be an ISO date" };
    receivedAt = d.toISOString();
  }

  const text = typeof input.text === "string" ? input.text.slice(0, MAX_BODY_CHARS) : null;
  const html = typeof input.html === "string" ? input.html.slice(0, MAX_BODY_CHARS) : null;
  if (!text?.trim() && !html?.trim()) return { ok: false, error: "text or html is required" };

  const attachments: EmailAttachment[] = [];
  if (Array.isArray(input.attachments)) {
    for (const a of input.attachments.slice(0, MAX_ATTACHMENTS)) {
      if (!isObject(a)) continue;
      const filename = str(a.filename, 300);
      if (!filename) continue;
      const size = typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? Math.round(a.size) : null;
      attachments.push({ filename, contentType: str(a.contentType, 200), size });
    }
  }

  return {
    ok: true,
    value: { messageId, from, to, subject: str(input.subject, MAX_SUBJECT) ?? "", receivedAt, text, html, attachments },
  };
}

/** The bare address in a header value: `Jane <jane@x.example>` gives `jane@x.example`. */
export function emailAddress(header: string | null | undefined): string | null {
  if (!header) return null;
  const angle = header.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angle?.[1] ?? header.match(/[^\s<>"',;:]+@[^\s<>"',;:]+/)?.[0];
  return bare ? bare.toLowerCase().replace(/[.)]+$/, "") : null;
}

export function emailDomain(address: string | null | undefined): string | null {
  const at = address?.lastIndexOf("@") ?? -1;
  if (!address || at < 0) return null;
  const domain = address.slice(at + 1).toLowerCase().trim();
  return domain || null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text from an HTML body: block tags become line breaks, table cells become tabs. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]*\t[ \t]*/g, "\t")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The body as plain text: the text part when present, else the HTML part converted. */
export function bodyText(email: Pick<NormalizedEmail, "text" | "html">): string {
  if (email.text?.trim()) return email.text.replace(/\r\n?/g, "\n");
  return email.html ? htmlToText(email.html) : "";
}

const FORWARD_MARKERS = [
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
  /^Begin forwarded message:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
];

/**
 * Senders found inside forwarded or replied-to parts, oldest (deepest) first. A request a
 * CDS dispatcher forwards is matched by the customer who wrote it, not by the dispatcher.
 */
export function quotedSenders(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    let first: { index: number; length: number } | null = null;
    for (const re of FORWARD_MARKERS) {
      const m = re.exec(rest);
      if (m && (first === null || m.index < first.index)) first = { index: m.index, length: m[0].length };
    }
    if (!first) break;
    rest = rest.slice(first.index + first.length);
    const header = rest.slice(0, 800).match(/^\s*From:\s*(.+)$/im);
    const address = emailAddress(header?.[1]);
    if (address) out.push(address);
  }
  return out.reverse();
}

export function isForwarded(email: Pick<NormalizedEmail, "subject">, text: string): boolean {
  return /^\s*(fwd?|fw)\s*:/i.test(email.subject) || FORWARD_MARKERS.some((re) => re.test(text));
}

/**
 * A stable message id for an email pasted on /cds/intake without one, so pasting the same
 * email twice is still processed once.
 */
export function pastedMessageId(from: string, subject: string, body: string): string {
  const digest = createHash("sha256").update(`${from.trim().toLowerCase()}\n${subject.trim()}\n${body.trim()}`).digest("hex");
  return `pasted-${digest.slice(0, 40)}`;
}
