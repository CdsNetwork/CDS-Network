/**
 * The machine-made request templates CDS receives, detected by subject and body markers
 * (never by sender alone: Ryder arrives through a CDS group address, the website form from
 * Wix). An email that matches one is read exactly here and the AI stage is not used.
 */
import { bodyText } from "../email";
import type { NormalizedEmail } from "../types";
import type { TemplateResult } from "./common";
import { isFirstStudentIprocure, parseFirstStudentIprocure } from "./first-student-iprocure";
import { isRyder, parseRyder } from "./ryder";
import { isWebsiteForm, parseWebsiteForm } from "./website-form";

export type { TemplateItem, TemplateResult } from "./common";

/** A reply or forward keeps the template's subject after "Re:" or "Fwd:". */
const stripPrefixes = (subject: string) => subject.replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, "");

export function detectTemplate(email: Pick<NormalizedEmail, "subject" | "text" | "html"> & Partial<NormalizedEmail>, text: string = bodyText(email)): TemplateResult | null {
  const subject = stripPrefixes(email.subject);
  if (isRyder(subject, text)) return parseRyder(subject, text);
  if (isFirstStudentIprocure(subject, text)) return parseFirstStudentIprocure(text);
  if (isWebsiteForm(subject, text)) return parseWebsiteForm(subject, text);
  return null;
}
