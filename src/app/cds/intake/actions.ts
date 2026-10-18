"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { dbMessage, text } from "@/components/cds-admin/server-utils";
import { isUuid } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { INTAKE_MAILBOX, intakeExtractor } from "@/lib/intake/config";
import { MAX_BODY_CHARS, pastedMessageId } from "@/lib/intake/email";
import { ingestEmail, processEmail, type IntakeOutcome } from "@/lib/intake/process";
import { supabaseIntakeStore } from "@/lib/intake/supabase-store";
import { createClient } from "@/lib/supabase/server";

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function describe(outcome: IntakeOutcome): string {
  if (outcome.duplicate) return "This email was already received. Nothing new was created.";
  switch (outcome.status) {
    case "converted":
      return "Draft work order created in Pending Review.";
    case "ignored":
      return `Marked as not a work request${outcome.message ? `: ${outcome.message}` : ""}.`;
    case "parsed":
      return `Read, but no order was created: ${outcome.message ?? "check the details below"}`;
    case "failed":
      return `Could not finish: ${outcome.message ?? "unknown error"}. Use Retry below.`;
    default:
      return "Saved.";
  }
}

/** The manual fallback: CDS pastes an email (for testing, or when the feed is down). */
export async function pasteEmail(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const from = text(formData, "from");
  const subject = text(formData, "subject");
  const body = text(formData, "body");
  const given = text(formData, "message_id");
  if (!from.includes("@")) return { error: "Enter the sender's email address (From)." };
  if (!body) return { error: "Paste the email text." };
  if (body.length > MAX_BODY_CHARS) return { error: "The email is too long. Paste the request part only." };
  if (from.length > 500 || subject.length > 1000 || given.length > 998) return { error: "One of the fields is too long." };

  const supabase = await createClient();
  try {
    const outcome = await ingestEmail(
      supabaseIntakeStore(supabase, me.id),
      {
        messageId: given || pastedMessageId(from, subject, body),
        from,
        to: [INTAKE_MAILBOX],
        subject,
        receivedAt: new Date().toISOString(),
        text: body,
        html: null,
        attachments: [],
      },
      { source: "paste", llm: intakeExtractor() },
    );
    revalidatePath("/cds/intake");
    if (outcome.status === "converted") revalidatePath("/cds");
    return outcome.status === "failed" ? { error: describe(outcome) } : { ok: true, message: describe(outcome) };
  } catch {
    return { error: "The email could not be saved. Try again." };
  }
}

/** Runs the pipeline again for one email. `force` treats an ignored email as a work request. */
export async function retryEmail(id: string, force: boolean): Promise<ActionState> {
  await requireCds();
  if (!isUuid(id)) return { error: "Unknown email." };
  const supabase = await createClient();
  try {
    const outcome = await processEmail(supabaseIntakeStore(supabase), id, { llm: intakeExtractor(), forceWorkRequest: force });
    revalidatePath("/cds/intake");
    if (outcome.status === "converted") revalidatePath("/cds");
    return outcome.status === "failed" ? { error: describe(outcome) } : { ok: true, message: describe(outcome) };
  } catch {
    return { error: "Could not process this email. Try again." };
  }
}

export async function ignoreEmail(id: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(id)) return { error: "Unknown email." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("inbound_emails")
    .update({ status: "ignored", error: null })
    .eq("id", id)
    .is("work_order_id", null);
  if (error) return { error: dbMessage(error) };
  revalidatePath("/cds/intake");
  return { ok: true, message: "Marked as not a work request." };
}

export async function addSenderDomain(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await requireCds();
  const customer = text(formData, "customer_id");
  const domain = text(formData, "domain").toLowerCase().replace(/^.*@/, "").replace(/\.$/, "");
  if (!isUuid(customer)) return { error: "Choose a customer." };
  if (!DOMAIN.test(domain) || domain.length > 253) return { error: "Enter a domain like fleet.example.com." };
  if (domain === INTAKE_MAILBOX.split("@")[1]) return { error: "That is CDS's own domain." };
  const supabase = await createClient();
  const { error } = await supabase.from("customer_email_domains").insert({ customer_id: customer, domain, updated_by: me.id });
  if (error) return { error: error.code === "23505" ? "That domain already belongs to a customer." : dbMessage(error) };
  revalidatePath("/cds/intake");
  return { ok: true, message: `Emails from ${domain} now match this customer.` };
}

export async function removeSenderDomain(id: string): Promise<ActionState> {
  await requireCds();
  if (!isUuid(id)) return { error: "Unknown domain." };
  const supabase = await createClient();
  const { error } = await supabase.from("customer_email_domains").delete().eq("id", id);
  if (error) return { error: dbMessage(error) };
  revalidatePath("/cds/intake");
  return { ok: true, message: "Removed." };
}
