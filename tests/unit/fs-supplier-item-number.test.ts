/**
 * First Student POs carry First Student's own "Item Number" (for example 10028-6) and CDS's
 * "Supplier Item Number" (CDS-CL-1057AM). The template read the Item Number first, so WO 101683
 * (PO 5552907) was matched from 10028-6. Sarah (CDS, 2026-11-06): for First Student orders the
 * part should always be assigned from the Supplier Item Number line.
 */
import { describe, expect, it, vi } from "vitest";
import type { LlmExtractor } from "@/lib/intake/llm";
import { parseEmail } from "@/lib/intake/parse";
import { parseFirstStudentIprocure } from "@/lib/intake/templates/first-student-iprocure";
import { extraction } from "../fixtures/intake/llm-fakes";
import { DPF_GASKET, reference, VBAND_CLAMP } from "../fixtures/intake/reference";
import { fsIprocureParts } from "../fixtures/intake/templates";

const po = (lines: string) => `Purchase Order Information:
  PO Number: 5552907
  Order Description: clamp

Purchase Order Detail Information:

${lines}
`;

describe("First Student Supplier Item Number", () => {
  it("assigns the part from the Supplier Item Number when there is one", () => {
    const r = parseFirstStudentIprocure(
      po(`  Line Number: 10
    Item Number: 10028-6
    Description: CLAMP, V-BAND, TURBOCHARGER, 4IN
    Price: $34.000
    Quantity Requested: 6.000
    Supplier Item Number: CDS-CL-1057AM
`),
    );
    expect(r.items[0]).toMatchObject({ partNumber: "CDS-CL-1057AM", qty: 6 });
  });

  it("falls back to the Item Number when the Supplier Item Number is missing", () => {
    const r = parseFirstStudentIprocure(
      po(`  Line Number: 10
    Item Number: 50389K
    Description: CLAMP
    Quantity Requested: 2.000
`),
    );
    expect(r.items[0]).toMatchObject({ partNumber: "50389K", qty: 2 });
  });
});

/** The fixture PO with one line: First Student's Item Number and CDS's Supplier Item Number. */
async function parseLine(itemNumber: string, supplierItemNumber: string) {
  const text = fsIprocureParts.text!.split("\nLine Number: 1")[0] + `
Line Number: 1
Item Number: ${itemNumber}
Description: CLAMP, V-BAND, TURBOCHARGER, 4IN
Price: 34.00
Quantity Requested: 6
Supplier Item Number: ${supplierItemNumber}
`;
  const llm = vi.fn<LlmExtractor>(async () => ({ ok: true, value: extraction(), model: "claude-sonnet-5-5" }));
  const p = await parseEmail({ ...fsIprocureParts, text }, reference(), { llm });
  expect(llm).not.toHaveBeenCalled();
  expect(p.template).toBe("first_student_iprocure");
  return p;
}

describe("First Student line matched to the catalog", () => {
  it("matches the Supplier Item Number before the Item Number", async () => {
    const p = await parseLine("FS-CLP-0310", "CDS-G-1051");
    expect(p.items).toEqual([expect.objectContaining({ catalog_item_id: DPF_GASKET.id, via: "sku", part_number: "CDS-G-1051", qty: 6 })]);
  });

  it("matches the Item Number as a First Student alias when the Supplier Item Number is not in the catalog", async () => {
    const p = await parseLine("FS-CLP-0310", "CDS-CL-1057AM");
    expect(p.items).toEqual([
      expect.objectContaining({ catalog_item_id: VBAND_CLAMP.id, via: "customer_alias", part_number: "FS-CLP-0310", qty: 6, price: 34 }),
    ]);
    expect(p.warnings.some((w) => /not matched/.test(w))).toBe(false);
  });

  it("leaves the line unmatched with the Supplier Item Number when neither number is known", async () => {
    const p = await parseLine("10028-6", "CDS-CL-1057AM");
    expect(p.items).toEqual([expect.objectContaining({ catalog_item_id: null, via: "none", part_number: "CDS-CL-1057AM", qty: 6 })]);
    expect(p.warnings).toContain("1 requested item(s) not matched to the catalog: CDS-CL-1057AM.");
  });
});
