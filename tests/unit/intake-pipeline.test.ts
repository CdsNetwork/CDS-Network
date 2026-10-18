/**
 * The whole parse over the invented fixtures, with the AI stage off, failing, or mocked.
 */
import { describe, expect, it } from "vitest";
import { buildDraftParams } from "@/lib/intake/draft";
import { DETERMINISTIC_ONLY_CAP, parseEmail } from "@/lib/intake/parse";
import { failingLlm, fakeLlm } from "../fixtures/intake/llm-fakes";
import {
  DOC_CLEAN,
  DPF_CLEAN,
  DPF_GASKET,
  FIRST_STUDENT,
  fixture,
  FIXTURES,
  loc0077,
  loc0424,
  loc0611,
  locFs12723,
  locFs30418,
  MISC_HARDWARE,
  reference,
  RYDER,
  VBAND_CLAMP,
} from "../fixtures/intake/reference";

const EMAIL_ID = "00000000-0000-4000-8000-0000000e0001";

describe("parseEmail without the AI stage", () => {
  it("turns the Ryder request into a complete draft, capped at low confidence", async () => {
    const p = await parseEmail(fixture("ryder-dpf-pickup"), reference(), { llm: null });
    expect(p.is_work_request).toBe(true);
    expect(p.customer).toMatchObject({ id: RYDER, via: "sender_domain" });
    expect(p.location).toMatchObject({ id: loc0424.id, via: "location_number" });
    expect(p.fields.unit_number).toEqual({ value: "284113", source: "regex", confidence: 0.9 });
    expect(p.fields.po_number.value).toBe("7741200");
    expect(p.fields.vin).toEqual({ value: "3AKJHHDR0KSKA7731", source: "regex", confidence: 0.95 });
    expect(p.fields.fulfillment).toEqual({ value: "pickup", source: "regex", confidence: 0.8 });
    expect(p.items.map((i) => i.catalog_item_id)).toEqual([DPF_CLEAN.id, DOC_CLEAN.id]);
    expect(p.request_type).toBe("service");
    expect(p.llm).toEqual({ used: false, model: null, error: null });
    expect(p.confidence).toBeLessThanOrEqual(DETERMINISTIC_ONLY_CAP);
    expect(p.confidence_label).toBe("low");
    expect(p.warnings[0]).toMatch(/not set up/);
  });

  it("matches First Student part numbers through the customer's aliases", async () => {
    const p = await parseEmail(fixture("first-student-parts"), reference(), { llm: null });
    expect(p.customer?.id).toBe(FIRST_STUDENT);
    expect(p.location?.id).toBe(locFs12723.id);
    expect(p.fields.fulfillment.value).toBe("shipping");
    expect(p.items).toEqual([
      expect.objectContaining({ part_number: "FS-DPF-0097", catalog_item_id: DPF_CLEAN.id, via: "customer_alias", qty: 1 }),
      expect.objectContaining({ part_number: "FS-GSK-1201", catalog_item_id: DPF_GASKET.id, via: "customer_alias", qty: 2 }),
    ]);
  });

  it("matches a forwarded request by its original author, not the dispatcher who forwarded it", async () => {
    const p = await parseEmail(fixture("forwarded-chain"), reference(), { llm: null });
    expect(p.original_sender).toBe("shoplead611@ryder.example");
    expect(p.customer).toMatchObject({ id: RYDER, via: "sender_domain" });
    expect(p.location?.id).toBe(loc0611.id);
    expect(p.fields.unit_number.value).toBe("51207");
    expect(p.fields.po_number.value).toBe("7741388");
    expect(p.fields.fulfillment.value).toBe("shipping");
  });

  it("matches the location by address when there is no location number", async () => {
    const p = await parseEmail(fixture("no-location-number"), reference(), { llm: null });
    // Without the AI stage the address is only known through ZIP and street number in the text.
    expect(p.location).toMatchObject({ id: loc0077.id, via: "address" });
    expect(p.fields.po_number.value).toBeNull();
  });

  it("ignores a remittance notice", async () => {
    const p = await parseEmail(fixture("not-work-request"), reference(), { llm: null });
    expect(p.is_work_request).toBe(false);
    expect(p.ignore_reason).toBe("Payment or remittance notice");
  });

  it("reads a purchasing portal HTML email", async () => {
    const p = await parseEmail(fixture("first-student-html-portal"), reference(), { llm: null });
    expect(p.customer?.id).toBe(FIRST_STUDENT);
    expect(p.location?.id).toBe(locFs30418.id);
    expect(p.fields.unit_number.value).toBe("7720");
    expect(p.items.map((i) => [i.catalog_item_id, i.qty])).toEqual([
      [DOC_CLEAN.id, 1],
      [VBAND_CLAMP.id, 2],
    ]);
  });

  it("BUG-M2-5: keeps a requested cleaning next to part numbers and never proposes Misc. hardware", async () => {
    const p = await parseEmail(fixture("ryder-dpf-with-parts"), reference(), { llm: null });
    expect(p.customer?.id).toBe(RYDER);
    expect(p.items.map((i) => [i.catalog_item_id, i.qty])).toEqual([
      [DPF_GASKET.id, 2],
      [DPF_CLEAN.id, 1],
    ]);
    expect(p.items.some((i) => i.catalog_item_id === MISC_HARDWARE.id || i.sku === MISC_HARDWARE.sku)).toBe(false);
    expect(p.request_type).toBe("service");
  });

  it("does not add a cleaning for a component that is only named in a part description", async () => {
    const email = {
      ...fixture("ryder-dpf-with-parts"),
      text: "Location: 0424\nUnit #: 284190\nPO#: 7741255\n\nPlease send 2 x CDS-G-1051 DPF inlet gaskets.\n",
    };
    const p = await parseEmail(email, reference(), { llm: null });
    expect(p.items.map((i) => i.catalog_item_id)).toEqual([DPF_GASKET.id]);
    expect(p.request_type).toBe("parts_only");
  });

  it("does not add the same cleaning twice when a part number already maps to it", async () => {
    const p = await parseEmail(fixture("first-student-parts"), reference(), { llm: null });
    expect(p.items.filter((i) => i.catalog_item_id === DPF_CLEAN.id)).toHaveLength(1);
  });

  it("parses every fixture without throwing", async () => {
    for (const name of FIXTURES) await expect(parseEmail(fixture(name), reference(), { llm: null })).resolves.toBeTruthy();
  });

  it("can be forced to treat an ignored email as a work request", async () => {
    const p = await parseEmail(fixture("not-work-request"), reference(), { llm: null, forceWorkRequest: true });
    expect(p.is_work_request).toBe(true);
  });
});

describe("parseEmail with the AI stage", () => {
  it("fills gaps from the AI but keeps pattern matches and ids from code", async () => {
    const p = await parseEmail(fixture("no-location-number"), reference(), {
      llm: fakeLlm({
        customer_name: "Ryder",
        location_address: "1180 Industrial Pkwy, Fairview, OH 44126",
        unit_number: "T-55021",
        fulfillment: "pickup",
        items: [{ description: "DPF cleaning", part_number: null, quantity: 1, component: "DPF" }],
        requested_work_summary: "Clean one DPF",
        notes: "Back door pickup",
        confidence: "high",
      }),
    });
    expect(p.llm).toEqual({ used: true, model: "claude-sonnet-5-5", error: null });
    expect(p.location).toMatchObject({ id: loc0077.id, via: "address", confidence: 0.85 });
    expect(p.fields.unit_number.source).toBe("regex");
    expect(p.fields.location_address).toMatchObject({ source: "llm" });
    expect(p.fields.requested_work).toMatchObject({ value: "Clean one DPF", source: "llm" });
    expect(p.items[0]).toMatchObject({ catalog_item_id: DPF_CLEAN.id, source: "llm" });
    expect(p.confidence).toBeGreaterThan(DETERMINISTIC_ONLY_CAP);
  });

  it("warns when the AI and the pattern disagree, and keeps the pattern", async () => {
    const p = await parseEmail(fixture("ryder-dpf-pickup"), reference(), { llm: fakeLlm({ po_number: "7741299" }) });
    expect(p.fields.po_number).toMatchObject({ value: "7741200", source: "regex" });
    expect(p.warnings.join(" ")).toMatch(/PO differs/);
  });

  it("does not take a customer from an AI-written original sender that is not in the email", async () => {
    const stranger = { ...fixture("ryder-dpf-pickup"), from: "someone@unknown.example" };
    const p = await parseEmail(stranger, reference(), { llm: fakeLlm({ original_sender_email: "fake@ryder.example" }) });
    expect(p.customer).toBeNull();

    const quoted = { ...stranger, text: `${stranger.text}\nFrom: Real Person <real@ryder.example>` };
    const q = await parseEmail(quoted, reference(), { llm: fakeLlm({ original_sender_email: "real@ryder.example" }) });
    expect(q.customer).toMatchObject({ id: RYDER, via: "sender_domain" });
  });

  it("merges an AI item with the same part number found by pattern", async () => {
    const p = await parseEmail(fixture("first-student-parts"), reference(), {
      llm: fakeLlm({ items: [{ description: "Gasket, DPF inlet", part_number: "fs-gsk-1201", quantity: 2, component: null }] }),
    });
    expect(p.items.filter((i) => i.catalog_item_id === DPF_GASKET.id)).toHaveLength(1);
  });

  it("follows the AI when it says the email is not a work request", async () => {
    const p = await parseEmail(fixture("not-work-request"), reference(), {
      llm: fakeLlm({ is_work_request: false, not_work_request_reason: "Payment notice" }),
    });
    expect(p.is_work_request).toBe(false);
    expect(p.ignore_reason).toBe("Payment notice");
  });

  it("keeps an email with a unit, PO and part even when the AI says it is not a request", async () => {
    const p = await parseEmail(fixture("ryder-dpf-pickup"), reference(), { llm: fakeLlm({ is_work_request: false }) });
    expect(p.is_work_request).toBe(true);
    expect(p.warnings.join(" ")).toMatch(/kept for review/);
  });

  it("falls back to pattern matching when the AI call fails", async () => {
    const p = await parseEmail(fixture("ryder-dpf-pickup"), reference(), { llm: failingLlm });
    expect(p.llm.used).toBe(false);
    expect(p.llm.error).toMatch(/529/);
    expect(p.location?.id).toBe(loc0424.id);
    expect(p.confidence).toBeLessThanOrEqual(DETERMINISTIC_ONLY_CAP);
  });
});

describe("buildDraftParams", () => {
  it("builds a Pending Review draft with lines, notes and review reason", async () => {
    const email = fixture("first-student-parts");
    const p = await parseEmail(email, reference(), { llm: null });
    const d = buildDraftParams(EMAIL_ID, email, p);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.params).toMatchObject({
      p_email: EMAIL_ID,
      p_customer: FIRST_STUDENT,
      p_location: locFs12723.id,
      p_location_label: null,
      p_request_type: "service",
      p_fulfillment: "shipping",
      p_unit_number: "3318",
      p_po_number: "4500123987",
      p_lines: [
        { catalog_item_id: DPF_CLEAN.id, qty: 1 },
        { catalog_item_id: DPF_GASKET.id, qty: 2 },
      ],
    });
    expect(d.params.p_review_reason).toMatch(/^From email \(low confidence\): check before dispatch$/);
    expect(d.params.p_internal_notes).toContain("pattern matching only");
  });

  it("names what is missing and keeps the email's location text when no location matched", async () => {
    const email = { ...fixture("no-location-number"), html: "<p>DPF cleaning for unit T-55021 at our yard on Elm.</p>" };
    const p = await parseEmail(email, reference(), { llm: fakeLlm({ location_name: "Elm yard" }) });
    const d = buildDraftParams(EMAIL_ID, email, p);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.params.p_location).toBeNull();
    expect(d.params.p_location_label).toBe("Elm yard");
    expect(d.params.p_review_reason).toContain("missing location, PO number");
  });

  it("does not build a draft without a customer or for an ignored email", async () => {
    const stranger = { ...fixture("ryder-dpf-pickup"), from: "x@unknown.example" };
    const p = await parseEmail(stranger, reference(), { llm: null });
    expect(buildDraftParams(EMAIL_ID, stranger, p)).toEqual({ ok: false, reason: expect.stringMatching(/Customer not recognised/) });

    const remit = fixture("not-work-request");
    const q = await parseEmail(remit, reference(), { llm: null });
    expect(buildDraftParams(EMAIL_ID, remit, q)).toEqual({ ok: false, reason: "Payment or remittance notice" });
  });

  it("keeps the larger quantity when the same item is read twice", async () => {
    const email = fixture("ryder-dpf-pickup");
    const p = await parseEmail(email, reference(), {
      llm: fakeLlm({
        items: [
          { description: "DPF clean", part_number: null, quantity: 1, component: "DPF" },
          { description: "DPF cleaning", part_number: null, quantity: 2, component: "DPF" },
        ],
      }),
    });
    const d = buildDraftParams(EMAIL_ID, email, p);
    // The AI left out the DOC clean the email asks for; it is still added from the text.
    expect(d.ok && d.params.p_lines).toEqual([
      { catalog_item_id: DPF_CLEAN.id, qty: 2 },
      { catalog_item_id: DOC_CLEAN.id, qty: 1 },
    ]);
  });
});
