/**
 * Internal status saves on change on the work order page, as in the work order list, with
 * the same component (Saving... while it saves, then a short Saved confirmation).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("internal status select", () => {
  const wo = source("app/cds/work-orders/[id]/page.tsx");
  const edits = source("components/cds-wo/ListRowEdits.tsx");
  const dashboard = source("app/cds/page.tsx");

  it("the work order page uses the list's save-on-change select, without a Save button", () => {
    expect(wo).toMatch(/<ListInternalStatusSelect[\s\S]*?woId=\{wo\.id\}[\s\S]*?value=\{internal\?\.internal_status \?\? null\}/);
    expect(wo).not.toMatch(/setInternalStatus\.bind\(null, wo\.id\)/);
    expect(wo).toMatch(/htmlFor="internal-status"/);
  });

  it("still saves through the server action that writes the History event", () => {
    expect(edits).toMatch(/await setInternalStatus\(woId, \{\}, fd\)/);
  });

  it("shows Saving... while pending and Saved after success in a status region", () => {
    expect(edits).toMatch(/role="status"/);
    expect(edits).toMatch(/"Saving\.\.\."/);
    expect(edits).toMatch(/"Saved"/);
  });

  it("is not remounted by a key on the saved value (the Saved confirmation stays visible)", () => {
    expect(dashboard).not.toMatch(/<ListInternalStatusSelect\s+key=/);
    expect(wo).not.toMatch(/<ListInternalStatusSelect\s+key=/);
  });
});
