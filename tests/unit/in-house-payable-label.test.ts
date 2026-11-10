/**
 * A work order dispatched to CDS's in-house shop has no affiliate to pay: the shop total is
 * what CDS itself paid. The detail page's summary card and the CDS list must say so, the same
 * way the line rate column and the summary row already do.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shopPayableLabel } from "@/lib/format";

describe("shopPayableLabel", () => {
  it("names the shop total CDS cost for the in-house shop and affiliate payable otherwise", () => {
    expect(shopPayableLabel(true)).toBe("CDS cost (in-house)");
    expect(shopPayableLabel(false)).toBe("Affiliate payable");
  });
});

describe("pages use the label", () => {
  const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

  it("the work order summary card does not hardcode AFFILIATE PAYABLE", () => {
    const page = read("app/cds/work-orders/[id]/page.tsx");
    expect(page).not.toMatch(/>\s*AFFILIATE PAYABLE\s*</);
    expect(page).toContain("shopPayableLabel(inHouse).toUpperCase()");
    expect(page).toContain("{shopPayableLabel(inHouse)}");
  });

  it("the CDS list loads is_in_house and marks in-house rows as CDS cost", () => {
    const list = read("app/cds/page.tsx");
    expect(list).toMatch(/affiliates\(display_name, is_in_house\)/);
    expect(list).toMatch(/inHouse && <div className="small">CDS cost<\/div>/);
  });
});
