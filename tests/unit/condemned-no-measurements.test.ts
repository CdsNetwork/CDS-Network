/**
 * Condemned filters are not measured (CDS, 2026-11-12): on the shop's component card the
 * pressure and weight fields are required for a DPF or DOC, except when the result is
 * condemned. The database rule is in tests/rls/condemned-no-measurements.test.ts.
 */
import { describe, expect, it } from "vitest";
import { measurementsRequired } from "@/components/shop/types";

describe("measurementsRequired", () => {
  it("a condemned DPF or DOC needs no measurements", () => {
    expect(measurementsRequired("DPF", "condemned")).toBe(false);
    expect(measurementsRequired("DOC", "condemned")).toBe(false);
  });

  it("a DPF that is cleaned, failed or has no result yet still needs them", () => {
    for (const result of ["cleaned", "failed", "", null]) {
      expect(measurementsRequired("DPF", result)).toBe(true);
    }
  });

  it("a DOC is never required to be measured (Sarah, CDS, 2026-11-17)", () => {
    for (const result of ["cleaned", "", null]) {
      expect(measurementsRequired("DOC", result)).toBe(false);
    }
  });

  it("SCR and EGR are never measured", () => {
    expect(measurementsRequired("SCR", "cleaned")).toBe(false);
    expect(measurementsRequired("EGR", "passed")).toBe(false);
  });
});
