/**
 * Items priced on the order (CDS-NEW-FILTER, reconditioned filters) added without their amount
 * (20261117030000_order_priced_without_amount.sql; Sarah, CDS office, 2026-11-16).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pricedLineInput } from "@/lib/pass-through";
import { matchableCatalog, splitCatalog, type CatalogRef } from "@/lib/intake/types";

const item = (id: string, sku: string, extra: Partial<CatalogRef> = {}): CatalogRef =>
  ({ id, sku, name: sku, category: "part", oe_cross: null, ...extra }) as CatalogRef;

describe("the Priced on this order box", () => {
  it("adds the line with the customer price left empty", () => {
    expect(pricedLineInput("", "", "")).toEqual({ ok: true, description: "", amount: null, shopRate: null });
    expect(pricedLineInput("", " ", "450")).toEqual({ ok: true, description: "", amount: null, shopRate: 450 });
  });

  it("still refuses a typed price that is not above zero", () => {
    expect(pricedLineInput("", "0", "")).toMatchObject({ ok: false });
    expect(pricedLineInput("", "abc", "")).toMatchObject({ ok: false });
  });

  it("does not require the price on the order page", () => {
    const page = readFileSync("src/app/cds/work-orders/[id]/page.tsx", "utf8");
    expect(page).not.toMatch(/id="priced-amount" name="amount" className="input" inputMode="decimal" required/);
  });
});

describe("entering the amount later on the line", () => {
  it("the order page offers it on a line without a price", () => {
    const page = readFileSync("src/app/cds/work-orders/[id]/page.tsx", "utf8");
    expect(page).toMatch(/setLinePrice\.bind\(null, wo\.id, l\.id\)/);
    const actions = readFileSync("src/app/cds/work-orders/[id]/actions.ts", "utf8");
    expect(actions).toMatch(/rpc\("cds_set_line_price"/);
  });
});

describe("the Create Work Order form", () => {
  it("does not offer Misc. hardware (its amount comes from the shop's invoice, on the order page)", () => {
    const page = readFileSync("src/app/cds/work-orders/new/page.tsx", "utf8");
    expect(page).toMatch(/price_per_line, pass_through/);
  });

  it("shows an item priced on the order as set on the order, not as a missing fleet price", () => {
    const form = readFileSync("src/components/cds-wo/NewWorkOrderForm.tsx", "utf8");
    expect(form).toMatch(/Price set on this order/);
  });
});

describe("email intake", () => {
  const regular = item("1", "SVC-DPF", { price_per_line: false });
  const newFilter = item("2", "CDS-NEW-FILTER", { price_per_line: true, pass_through: false });
  const misc = item("3", "CDS-MISC-HARDWARE", { price_per_line: true });

  it("proposes an item priced on the order (added with no price), never Misc. hardware", () => {
    expect(matchableCatalog([regular, newFilter, misc]).map((c) => c.sku)).toEqual(["SVC-DPF", "CDS-NEW-FILTER"]);
    expect(splitCatalog([regular, newFilter, misc]).perLineItems.map((c) => c.sku)).toEqual(["CDS-MISC-HARDWARE"]);
  });
});
