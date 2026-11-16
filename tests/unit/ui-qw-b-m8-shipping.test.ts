/**
 * Shipping page: no static explainer box, leg status saves on change, and the label tile
 * says what it counts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("shipping page", () => {
  const page = source("app/cds/shipping/page.tsx");

  it("has no Shipping flows explainer", () => {
    expect(page).not.toMatch(/Shipping flows/);
    expect(page).not.toMatch(/Typical DPF shipping flow/);
  });

  it("sets a leg's status on change, without a Set button", () => {
    expect(page).toMatch(/action=\{setShipmentStatus\.bind\(null, s\.id\)\}/);
    expect(page).not.toMatch(/submitLabel="Set"/);
    expect(page).toMatch(/<SubmitOnChange>\s*<select name="status"/);
  });

  it("the tile counts legs that need a label or whose label failed, and says so", () => {
    expect(page).not.toMatch(/Label exceptions/);
    expect(page).toMatch(/const OPEN_LABEL = \["needed", "error"\]/);
    expect(page).toMatch(/<div className="k">Label needed or failed<\/div>/);
  });
});

describe("short pages", () => {
  it("the page column starts at the top instead of being centered in the grid (Shipping with one leg, 2026-11-17)", () => {
    const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.main \{[^}]*margin: 0 auto;/);
  });
});
