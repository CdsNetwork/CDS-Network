/**
 * The work order page shows no contract milestone names and no dead "Email customer"
 * button on the invoice card.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("work order invoice card", () => {
  const wo = source("app/cds/work-orders/[id]/page.tsx");

  it("has no Milestone 2 label", () => {
    expect(wo).not.toMatch(/Milestone ?2/);
  });

  it("has no disabled Email customer button", () => {
    expect(wo).not.toMatch(/Email customer/);
    expect(wo).not.toMatch(/emailButton/);
  });
});
