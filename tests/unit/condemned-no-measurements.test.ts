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

  it("a DPF or DOC that is cleaned, failed or has no result yet still needs them", () => {
    for (const type of ["DPF", "DOC"] as const) {
      for (const result of ["cleaned", "failed", "", null]) {
        expect(measurementsRequired(type, result)).toBe(true);
      }
    }
  });

  it("SCR and EGR are never measured", () => {
    expect(measurementsRequired("SCR", "cleaned")).toBe(false);
    expect(measurementsRequired("EGR", "passed")).toBe(false);
  });
});
