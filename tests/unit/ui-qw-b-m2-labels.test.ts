/**
 * One label per status on the CDS side ("Awaiting Acceptance" everywhere) and "No internal
 * status" for the empty internal status, in the list and on the work order page.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHOP_STATUS_LABEL, STATUS_LABEL } from "@/lib/format";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("status wording", () => {
  it("CDS uses Awaiting Acceptance; the shop labels are unchanged", () => {
    expect(STATUS_LABEL.awaiting_acceptance).toBe("Awaiting Acceptance");
    expect(STATUS_LABEL.rejected_by_affiliate).toBe("Declined by Shop");
    expect(SHOP_STATUS_LABEL.awaiting_acceptance).toBe("Awaiting Acceptance");
    expect(SHOP_STATUS_LABEL.completed).toBe("Complete");
  });

  it("the dashboard table uses STATUS_LABEL directly (no separate table labels)", () => {
    expect(source("components/cds-wo/woFilters.ts")).not.toMatch(/TABLE_STATUS_LABEL/);
    expect(source("app/cds/page.tsx")).not.toMatch(/TABLE_STATUS_LABEL/);
  });

  it("the empty internal status reads No internal status in both places", () => {
    const edits = source("components/cds-wo/ListRowEdits.tsx");
    const wo = source("app/cds/work-orders/[id]/page.tsx");
    expect(edits).toMatch(/<option value="">No internal status<\/option>/);
    expect(edits).not.toMatch(/Internal: blank/);
    expect(wo).not.toMatch(/<option value="">Blank<\/option>/);
  });
});
