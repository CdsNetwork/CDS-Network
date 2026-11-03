/**
 * Loop guard (CDS, 2026-11-04): the portal's status emails go to dispatch@cds.direct, and
 * dispatch@ forwards every email into the intake. The intake must store them as ignored with
 * a clear reason and never make or link a work order from them, whether they arrive directly,
 * auto-forwarded by Gmail (the original From is kept), or forwarded by hand by a dispatcher.
 */
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEmail } from "@/lib/intake/parse";
import { ingestEmail, processEmail } from "@/lib/intake/process";
import { handleResendWebhook, type ReceivedEmail } from "@/lib/intake/resend";
import type { NormalizedEmail } from "@/lib/intake/types";
import { buildPortalEmail, PORTAL_FROM } from "@/lib/portal-email";
import { fakeLlm } from "../fixtures/intake/llm-fakes";
import { memoryStore } from "../fixtures/intake/memory-store";
import { reference } from "../fixtures/intake/reference";

const WO = "11111111-1111-4111-8111-111111111111";
// A status email about a Ryder job: it names a location, unit, PO and a DPF, like a request.
const portal = buildPortalEmail("finished", {
  workOrderId: WO,
  woNumber: 101592,
  customer: "Ryder",
  location: "Ryder Location 0424",
  unitNumber: "284113",
  poNumber: "7741200",
  shop: "Enviromotive",
  at: "2026-11-04T18:15:00Z",
  declineReason: null,
  shopReference: "INV-1",
});
const workText = `${portal.text}\nDPF clean and DOC clean, Location: 0424, Unit #: 284113, PO#: 7741200\n`;

const direct = (over: Partial<NormalizedEmail> = {}): NormalizedEmail => ({
  messageId: "<portal-1@in.cds.direct>",
  from: PORTAL_FROM,
  to: ["dispatch@cds.direct"],
  subject: portal.subject,
  receivedAt: "2026-11-04T18:15:05Z",
  text: workText,
  html: null,
  attachments: [],
  inReplyTo: null,
  deliveredTo: "dispatch@cds.direct",
  ...over,
});

describe("intake ignores the portal's own emails", () => {
  it("ignores a portal email by its sender, with a clear reason", async () => {
    const p = await parseEmail(direct(), reference(), { llm: fakeLlm() });
    expect(p.is_work_request).toBe(false);
    expect(p.ignore_kind).toBe("portal_sent");
    expect(p.ignore_reason).toMatch(/portal/i);
  });

  it("ignores it even when CDS asks to treat it as a work request", async () => {
    const p = await parseEmail(direct(), reference(), { llm: fakeLlm(), forceWorkRequest: true });
    expect(p).toMatchObject({ is_work_request: false, ignore_kind: "portal_sent" });
    const { store, drafts } = memoryStore();
    const first = await ingestEmail(store, direct(), { source: "webhook", llm: fakeLlm() });
    const forced = await processEmail(store, first.id, { llm: fakeLlm(), forceWorkRequest: true });
    expect(forced).toMatchObject({ status: "ignored", workOrderId: null });
    expect(drafts).toHaveLength(0);
  });

  it("ignores a [Portal] email a dispatcher forwards by hand (original sender in the forwarded part)", async () => {
    const email = direct({
      messageId: "<fwd-portal@mail.cds.direct>",
      from: "Sarah Duty <sarah@cds.direct>",
      subject: `Fwd: ${portal.subject}`,
      text: `FYI\n\n---------- Forwarded message ---------\nFrom: ${PORTAL_FROM}\nDate: Wed, Nov 4, 2026 at 10:15 AM\nSubject: ${portal.subject}\nTo: <dispatch@cds.direct>\n\n${workText}`,
    });
    const p = await parseEmail(email, reference(), { llm: fakeLlm() });
    expect(p).toMatchObject({ is_work_request: false, ignore_kind: "portal_sent" });
  });

  it("does not ignore a [Portal] subject from an outside sender with no portal sender in it", async () => {
    const email = direct({ from: "Marcus Delgado <mdelgado@ryder.example>", text: "Location: 0424\nUnit #: 284113\nDPF clean please" });
    const p = await parseEmail(email, reference(), { llm: fakeLlm() });
    expect(p.ignore_kind).not.toBe("portal_sent");
  });
});

// ---------------------------------------------------------------- through the Resend webhook

const SECRET_BYTES = randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const NOW = Date.parse("2026-11-04T18:15:10Z");
const EMAIL_ID = "9b1c2d3e-0000-4000-8000-00000000beef";

function signedPost(body: unknown) {
  const raw = JSON.stringify(body);
  const id = "msg_portal";
  const ts = Math.floor(NOW / 1000);
  const sig = `v1,${createHmac("sha256", SECRET_BYTES).update(`${id}.${ts}.${raw}`).digest("base64")}`;
  return new Request("https://portal.example/api/intake/resend", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(ts), "svix-signature": sig },
    body: raw,
  });
}

/** The portal email after Gmail auto-forwarded it from dispatch@ to intake@in.cds.direct. */
const forwarded: ReceivedEmail = {
  id: EMAIL_ID,
  from: "portal@in.cds.direct",
  to: ["dispatch@cds.direct"],
  subject: portal.subject,
  created_at: "2026-11-04T18:15:06Z",
  text: workText,
  html: portal.html,
  headers: {
    from: PORTAL_FROM,
    to: "dispatch@cds.direct",
    "x-forwarded-to": "intake@in.cds.direct",
    "x-forwarded-for": "dispatch@cds.direct intake@in.cds.direct",
  },
  message_id: "<portal-101592-finished@in.cds.direct>",
  attachments: [],
};

function fakeResend(email: ReceivedEmail) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/attachments")) return Response.json({ data: [], has_more: false });
    return Response.json(email);
  }) as unknown as typeof fetch;
}

describe("Resend webhook with a portal email forwarded by dispatch@", () => {
  it("stores it as ignored and makes no work order", async () => {
    const { store, rows, drafts } = memoryStore();
    const r = await handleResendWebhook(signedPost({ type: "email.received", data: { email_id: EMAIL_ID } }), {
      config: { webhookSecret: SECRET, apiKey: "re_test" },
      store: () => store,
      llm: fakeLlm(),
      fetchImpl: fakeResend(forwarded),
      now: () => NOW,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "ignored", work_order_id: null });
    expect(drafts).toHaveLength(0);
    const row = [...rows.values()][0];
    expect(row.status).toBe("ignored");
    expect(row.parsed?.ignore_kind).toBe("portal_sent");
    expect(row.parsed?.mailbox).toBe("dispatch@cds.direct");
  });
});
