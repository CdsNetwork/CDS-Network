/**
 * A First Student PO for 4 x CDS-CL-1060AM (a V-band clamp, $69.69 each) became 4 x the
 * Cummins X12 DPF/DOC kit (CDS-KIT-X12-4): the clamp is not its own catalog item, but the
 * kit's OE cross reference lists the parts inside the kit, so the OE cross fallback matched
 * the kit. A part that is only a piece of a kit must never pull in the whole kit; the line is
 * left for CDS to pick (reported 2026-11-05, PO 5555028, WO 101791).
 */
import { describe, expect, it } from "vitest";
import { buildDraftParams } from "@/lib/intake/draft";
import { matchItem } from "@/lib/intake/match";
import { parseEmail } from "@/lib/intake/parse";
import type { CatalogRef } from "@/lib/intake/types";
import { fakeLlm } from "../fixtures/intake/llm-fakes";
import { aliases, catalog, DPF_GASKET, FIRST_STUDENT, fixture, reference } from "../fixtures/intake/reference";

const KIT: CatalogRef = {
  id: "9a9a9a9a-0000-4000-8000-00000000c001",
  sku: "CDS-KIT-X12-4",
  name: "Cummins X12 DPF/DOC Kit (kit)",
  category: "part",
  oe_cross:
    "CDS-G-1060AM (2), CDS-CL-1060AM (2), CDS-G-1058AM (1), CDS-CL-1058AM (1) | OE Part # (2) 2871772, (2) 5272750, (1) 2880214, (1) 2880212",
};
const withKit = [...catalog, KIT];
const m = (description: string, partNumber: string) =>
  matchItem({ description, partNumber, qty: 4, component: null, source: "regex" }, FIRST_STUDENT, withKit, aliases);

describe("kit components in the OE cross reference", () => {
  it("does not match a kit from the CDS number of one of its parts", () => {
    const r = m("CLAMP, V-BAND (CAN SEE ENVCL1060AM)", "CDS-CL-1060AM");
    expect(r.catalog_item_id).not.toBe(KIT.id);
    expect(r).toMatchObject({ catalog_item_id: null, via: "none", part_number: "CDS-CL-1060AM", qty: 4 });
  });

  it("does not match a kit from the OE number of one of its parts", () => {
    expect(m("gasket", "2871772").catalog_item_id).not.toBe(KIT.id);
  });

  it("still matches a kit by its own SKU", () => {
    expect(m("X12 kit", "CDS-KIT-X12-4")).toMatchObject({ catalog_item_id: KIT.id, via: "sku" });
  });

  it("still matches a single part by its OE cross reference", () => {
    expect(m("gasket", "2871999")).toMatchObject({ catalog_item_id: DPF_GASKET.id, via: "oe_cross" });
  });

  it("does not name-match a kit for a part number that is not in the catalog", () => {
    expect(m("Cummins X12 DPF/DOC kit", "CDS-CL-1060AM")).toMatchObject({ catalog_item_id: null, via: "none" });
  });

  it("names the unmatched part number for CDS on the draft", async () => {
    const email = {
      ...fixture("first-student-parts"),
      text: "Department: 12723M\nBus #3318\nPurchase Order: 4500123987\n\nFS Part No.   Description              Qty\nCDS-CL-1060AM   Clamp, V-band            4\n",
    };
    const p = await parseEmail(email, { ...reference(), catalog: withKit }, {
      llm: fakeLlm({ items: [{ description: "CLAMP, V-BAND (CAN SEE ENVCL1060AM)", part_number: "CDS-CL-1060AM", quantity: 4, component: null }] }),
    });
    expect(p.items.some((i) => i.catalog_item_id === KIT.id)).toBe(false);
    expect(p.items).toContainEqual(expect.objectContaining({ catalog_item_id: null, part_number: "CDS-CL-1060AM" }));
    const d = buildDraftParams("00000000-0000-4000-8000-0000000e0001", email, p);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.params.p_internal_notes).toMatch(/Not matched to the catalog: .*CDS-CL-1060AM/);
  });
});
