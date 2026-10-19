/**
 * The machine-made request templates (Ryder pick up request, First Student iProcure purchase
 * order, website fleet form) are read deterministically with exact fields and no AI call;
 * XPO free text gets deterministic PO, unit, meter and quantity; the emails that are not
 * requests are ignored with a reason, also without an AI call.
 */
import { describe, expect, it, vi } from "vitest";
import { buildDraftParams } from "@/lib/intake/draft";
import { intakeMailbox, validateNormalizedEmail } from "@/lib/intake/email";
import type { LlmExtractor } from "@/lib/intake/llm";
import { parseEmail } from "@/lib/intake/parse";
import { detectTemplate } from "@/lib/intake/templates";
import type { NormalizedEmail } from "@/lib/intake/types";
import { extraction } from "../fixtures/intake/llm-fakes";
import {
  customers,
  DOC_CLEAN,
  DPF_CLEAN,
  DPF_GASKET,
  EGR,
  FIRST_STUDENT,
  fixture,
  KIT_ISB,
  loc0424,
  loc0611,
  locFs12723,
  locFs30418,
  locPepsi3381,
  locXpoSfs,
  NOX_SENSOR,
  PEPSI,
  reference,
  RYDER,
  XPO,
} from "../fixtures/intake/reference";
import * as t from "../fixtures/intake/templates";

const spyLlm = () => vi.fn<LlmExtractor>(async () => ({ ok: true, value: extraction(), model: "claude-sonnet-5-5" }));
const EMAIL_ID = "00000000-0000-4000-8000-0000000e0009";

async function parseTemplate(email: NormalizedEmail) {
  const llm = spyLlm();
  const p = await parseEmail(email, reference(), { llm });
  expect(llm).not.toHaveBeenCalled();
  expect(p.llm.used).toBe(false);
  return p;
}

describe("template detection", () => {
  it.each([
    ["ryder", t.ryderDpfClamps],
    ["ryder", t.ryderEgrReturn],
    ["ryder", t.ryderMissing],
    ["first_student_iprocure", t.fsIprocureParts],
    ["first_student_iprocure", t.fsIprocureCleaning],
    ["website_form", t.webFormPepsi],
    ["website_form", t.webFormAmerit],
  ])("detects %s by subject and body, whatever the sender", (name, email) => {
    expect(detectTemplate(email)?.template).toBe(name);
    // Same email from an unrelated sender: still the template (Ryder arrives via a CDS group, the form via Wix).
    expect(detectTemplate({ ...email, from: "Someone <someone@elsewhere.example>" })?.template).toBe(name);
  });

  it("needs the body markers, not only the subject", () => {
    expect(detectTemplate({ ...t.ryderEgrReturn, text: "DPF ready" })).toBeNull();
    expect(detectTemplate({ ...t.fsIprocureParts, text: "see attached" })).toBeNull();
    expect(detectTemplate({ ...t.webFormPepsi, text: "hello" })).toBeNull();
    expect(detectTemplate(t.xpoRequest)).toBeNull();
    expect(detectTemplate(fixture("ryder-dpf-pickup"))).toBeNull();
  });
});

describe("Ryder pick up request", () => {
  it("reads every field of the HTML form and proposes the DPF cleaning; clamps and gaskets go to CDS review", async () => {
    const p = await parseTemplate(t.ryderDpfClamps);
    expect(p.template).toBe("ryder");
    expect(p.is_work_request).toBe(true);
    expect(p.customer).toMatchObject({ id: RYDER, via: "template" });
    expect(p.location).toMatchObject({ id: loc0424.id, via: "location_number" });
    const f = p.fields;
    expect(f.location_number).toEqual({ value: "424", source: "template", confidence: 0.98 });
    expect(f.location_name?.value).toBe("Ryder - LAKEMONT");
    expect(f.location_address.value).toBe("400 Example Rd, Lakemont, PA 15000");
    expect(f.unit_number.value).toBe("284113");
    expect(f.po_number.value).toBe("0424118833");
    expect(f.region?.value).toBe("Northeast");
    expect(f.requested_date?.value).toBe("2026-10-21");
    expect(f.order_type?.value).toBe("G14 Classified");
    expect(f.mileage?.value).toBe(412550);
    expect(f.serial_number?.value).toBe("SN-FAKE-77120");
    expect(f.manufacturer?.value).toBe("Freightliner");
    expect(f.part_number?.value).toBe("A0009999");
    expect(f.comments?.value).toBe("Filter is on the rack by bay 2");
    expect(f.fulfillment.value).toBe("pickup");
    expect(p.items.map((i) => i.catalog_item_id)).toEqual([DPF_CLEAN.id]);
    expect(p.warnings.join(" ")).toMatch(/DPF Clamps and Gaskets.*kit/);
    expect(p.request_type).toBe("service");
    expect(p.confidence_label).toBe("high");
  });

  it("maps the EGR cooler cleaning with return to the location", async () => {
    const p = await parseTemplate(t.ryderEgrReturn);
    expect(p.location?.id).toBe(loc0611.id);
    expect(p.items).toEqual([expect.objectContaining({ catalog_item_id: EGR.id, return_to_location: true })]);
    expect(p.fields.return_to_location?.value).toBe(true);
    expect(p.fields.requested_work.value).toMatch(/return to the location/i);
    expect(p.fields.part_number?.value ?? null).toBeNull();
    expect(p.confidence_label).toBe("high");
  });

  it("proposes several services and the clamp and gasket kit when the Part # matches one", async () => {
    const p = await parseTemplate(t.ryderDocKit);
    expect(p.items.map((i) => i.catalog_item_id)).toEqual([DPF_CLEAN.id, DOC_CLEAN.id, KIT_ISB.id]);
    expect(p.warnings.join(" ")).not.toMatch(/Clamps and Gaskets/);
  });

  it("keeps a draft with what is missing named, and no high confidence", async () => {
    const p = await parseTemplate(t.ryderMissing);
    expect(p.is_work_request).toBe(true);
    expect(p.customer?.id).toBe(RYDER);
    expect(p.location).toBeNull();
    expect(p.fields.location_number.value).toBe("999");
    expect(p.fields.unit_number.value).toBeNull();
    expect(p.fields.po_number.value).toBeNull();
    expect(p.fields.mileage?.value ?? null).toBeNull();
    expect(p.items.map((i) => i.catalog_item_id)).toEqual([DOC_CLEAN.id]);
    expect(p.confidence_label).not.toBe("high");
    expect(p.warnings).toContain("Location not matched.");
  });

  it("warns when the PO is not 10 digits", async () => {
    const email = { ...t.ryderEgrReturn, text: t.ryderEgrReturn.text!.replace("PO #: 0611200457", "PO #: 61120") };
    const p = await parseTemplate(email);
    expect(p.fields.po_number.value).toBe("61120");
    expect(p.warnings.join(" ")).toMatch(/PO.*10 digits/);
  });

  it("is read as a template even as a reply on a thread", async () => {
    const p = await parseTemplate({ ...t.ryderEgrReturn, inReplyTo: "<x@ryder.example>" });
    expect(p.is_work_request).toBe(true);
    expect(p.template).toBe("ryder");
  });

  it("fills the new draft fields", () => {
    return parseTemplate(t.ryderEgrReturn).then((p) => {
      const d = buildDraftParams(EMAIL_ID, t.ryderEgrReturn, p);
      if (!d.ok) throw new Error(d.reason);
      expect(d.params).toMatchObject({
        p_unit_number: "51207",
        p_po_number: "0611200457",
        p_mileage: 287004,
        p_requested_date: "2026-10-22",
        p_return_to_location: true,
        p_order_type: "G14 Classified",
        p_customer_region: "Northeast",
        p_fulfillment: "pickup",
        p_lines: [{ catalog_item_id: EGR.id, qty: 1 }],
      });
      expect(d.params.p_internal_notes).toMatch(/Please call before arriving/);
    });
  });
});

describe("First Student iProcure purchase order", () => {
  it("reads a parts order line by line and flags a price that differs from the portal", async () => {
    const p = await parseTemplate(t.fsIprocureParts);
    expect(p.template).toBe("first_student_iprocure");
    expect(p.customer).toMatchObject({ id: FIRST_STUDENT, via: "template" });
    expect(p.location?.id).toBe(locFs12723.id);
    const f = p.fields;
    expect(f.po_number.value).toBe("5512345");
    expect(f.location_number.value).toBe("12723");
    expect(f.location_suffix?.value).toBe("MM");
    expect(f.order_description?.value).toBe("NOX SENSORS AND GASKETS BUS 4410");
    expect(f.unit_number.value).toBe("4410");
    expect(f.contact_name?.value).toBe("Robin Sample");
    expect(f.contact_email?.value).toBe("robin.sample@firststudent.example");
    expect(f.requested_date?.value).toBe("2026-10-28");
    expect(f.cost_center?.value).toBe("12723-MAINT");
    expect(f.fulfillment.value).toBe("shipping");
    expect(p.items).toEqual([
      expect.objectContaining({ catalog_item_id: NOX_SENSOR.id, qty: 2, price: 410, portal_price: 395, taxable: true, required_date: "2026-10-28" }),
      expect.objectContaining({ catalog_item_id: DPF_GASKET.id, qty: 4, price: 20, portal_price: 20 }),
    ]);
    expect(p.warnings.filter((w) => /price/i.test(w))).toEqual([
      "PO price for ENV-NOX-1619 is 410.00, the portal price for this customer is 395.00: check before invoicing.",
    ]);
    expect(p.request_type).toBe("parts_only");
    expect(p.confidence_label).toBe("high");
    const d = buildDraftParams(EMAIL_ID, t.fsIprocureParts, p);
    if (!d.ok) throw new Error(d.reason);
    expect(d.params).toMatchObject({ p_contact_name: "Robin Sample", p_contact_email: "robin.sample@firststudent.example", p_requested_date: "2026-10-28" });
  });

  it("reads a cleaning order through the customer's item number", async () => {
    const p = await parseTemplate(t.fsIprocureCleaning);
    expect(p.location?.id).toBe(locFs30418.id);
    expect(p.fields.unit_number.value).toBe("7720");
    expect(p.items).toEqual([expect.objectContaining({ catalog_item_id: DPF_CLEAN.id, via: "customer_alias", qty: 1, price: 325, taxable: false })]);
    expect(p.warnings.some((w) => /price/i.test(w))).toBe(false);
    expect(p.request_type).toBe("service");
  });
});

describe("website fleet request form", () => {
  it("reads the fleet, contact, pickup and job details", async () => {
    const p = await parseTemplate(t.webFormPepsi);
    expect(p.template).toBe("website_form");
    expect(p.customer).toMatchObject({ id: PEPSI, via: "template" });
    expect(p.location?.id).toBe(locPepsi3381.id);
    const f = p.fields;
    expect(f.contact_name?.value).toBe("Jordan Fictional");
    expect(f.store_room?.value).toBe("3381");
    expect(f.contact_phone?.value).toBe("(555) 010-2233");
    expect(f.contact_email?.value).toBe("shop3381@pepsi.example");
    expect(f.location_address.value).toBe("500 Example Blvd, Springfield, IL 62700");
    expect(f.pickup_option?.value).toBe("Pick up at my location");
    expect(f.fulfillment.value).toBe("pickup");
    expect(f.mileage?.value).toBe(312000);
    expect(f.po_number.value).toBe("4500012345");
    expect(f.vin.value).toBe("1FUJGLDR5CLZZ1234");
    expect(f.part_number?.value).toBe("A0009999");
    expect(f.filter_options?.value).toBe("DPF");
    expect(f.parts_or_service?.value).toBe("Emission Service");
    expect(f.comments?.value).toBe("Filter is wrapped on a pallet");
    expect(p.items.map((i) => i.catalog_item_id)).toEqual([DPF_CLEAN.id]);
  });

  it("keeps a fleet that is not a customer for CDS, with the fleet named", async () => {
    const p = await parseTemplate(t.webFormAmerit);
    expect(p.is_work_request).toBe(true);
    expect(p.customer).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/Amerit Fleet/);
    expect(p.fields.fulfillment.value).toBe("shipping");
    expect(p.items.map((i) => i.catalog_item_id)).toEqual([DPF_CLEAN.id, DOC_CLEAN.id]);
    expect(buildDraftParams(EMAIL_ID, t.webFormAmerit, p)).toMatchObject({ ok: false });
  });
});

describe("XPO free text at xpo@cds.direct", () => {
  it("records the inbox the email arrived at", () => {
    expect(intakeMailbox(t.xpoRequest)).toBe("xpo@cds.direct");
    expect(intakeMailbox(t.ryderEgrReturn)).toBe("ryder@cds.direct");
    expect(intakeMailbox({ ...t.xpoRequest, to: ["someone@else.example"] })).toBe("dispatch@cds.direct");
    expect(intakeMailbox({ ...t.xpoRequest, deliveredTo: "dispatch@cds.direct" })).toBe("dispatch@cds.direct");
  });

  it("reads PO, unit, meter, quantity and part number, and maps the inbox to XPO", async () => {
    const p = await parseEmail(t.xpoRequest, reference(), { llm: null });
    expect(p.template ?? null).toBeNull();
    expect(p.mailbox).toBe("xpo@cds.direct");
    expect(p.customer).toMatchObject({ id: XPO, via: "inbox" });
    expect(p.location?.id).toBe(locXpoSfs.id);
    expect(p.fields.po_number.value).toBe("902814");
    expect(p.fields.unit_number.value).toBe("0632-4471");
    expect(p.fields.mileage?.value).toBe(512880);
    expect(p.items).toEqual([expect.objectContaining({ catalog_item_id: DPF_CLEAN.id, qty: 1, part_number: "A6809999" })]);
    expect(p.fields.fulfillment.value).toBe("pickup");
  });

  it("still runs the AI stage for XPO free text", async () => {
    const llm = spyLlm();
    await parseEmail(t.xpoRequest, reference(), { llm });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("does not guess a customer when XPO is not in the portal", async () => {
    const ref = { ...reference(), customers: customers.filter((c) => c.id !== XPO) };
    const p = await parseEmail(t.xpoRequest, ref, { llm: null });
    expect(p.customer).toBeNull();
    expect(p.is_work_request).toBe(true);
  });
});

describe("emails that are not requests", () => {
  it.each(t.ignored.map((c) => [c.name, c.kind, c.email] as const))("ignores %s", async (_name, kind, email) => {
    const llm = spyLlm();
    const p = await parseEmail(email, reference(), { llm });
    expect(p.is_work_request).toBe(false);
    expect(p.ignore_kind).toBe(kind);
    expect(p.ignore_reason).toBeTruthy();
    expect(llm).not.toHaveBeenCalled();
  });

  it("reads the PO number of a Ryder PO issued email", async () => {
    const p = await parseEmail(t.ryderPoIssued, reference(), { llm: null });
    expect(p.is_work_request).toBe(false);
    expect(p.ignore_kind).toBe("ryder_po");
    expect(p.fields.po_number.value).toBe("0424118833");
  });

  it("processes an ignored email when CDS forces it", async () => {
    const p = await parseEmail(fixture("forwarded-chain"), reference(), { llm: null, forceWorkRequest: true });
    expect(p.is_work_request).toBe(true);
    expect(p.customer?.id).toBe(RYDER);
  });
});

describe("normalized email", () => {
  it("accepts In-Reply-To and the delivered-to inbox", () => {
    const r = validateNormalizedEmail({ messageId: "<a@b>", from: "x@y.example", text: "hi", inReplyTo: " <p@q> ", deliveredTo: "XPO@cds.direct" });
    expect(r.ok && r.value).toMatchObject({ inReplyTo: "<p@q>", deliveredTo: "xpo@cds.direct" });
  });
});
