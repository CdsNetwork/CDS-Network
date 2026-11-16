/**
 * One inbound email whose parsed JSON has no fields (only location_candidates, as on TEST)
 * must not take down the whole Email Intake page.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsedView } from "@/lib/intake/parsed-view";
import type { ParsedEmail } from "@/lib/intake/types";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("parsedView", () => {
  it("fills in what a partial parsed record is missing", () => {
    const raw = { location_candidates: [{ id: "l1", code: "101", name: "Main" }] } as unknown as ParsedEmail;
    const p = parsedView(raw);
    expect(p).not.toBeNull();
    expect(p!.fields).toEqual({});
    expect(p!.fields.requested_date?.value).toBeUndefined();
    expect(p!.location_candidates).toHaveLength(1);
    expect(p!.customer_candidates).toEqual([]);
    expect(p!.items).toEqual([]);
    expect(p!.warnings).toEqual([]);
    expect(p!.llm).toEqual({ used: false, model: null, error: null });
    expect(p!.confidence).toBeNull();
    expect(p!.confidence_label).toBeNull();
  });

  it("returns null when nothing was read", () => {
    expect(parsedView(null)).toBeNull();
    expect(parsedView(undefined)).toBeNull();
  });

  it("keeps a full record as it is", () => {
    const fields = { po_number: { value: "PO1", source: "regex" } };
    const raw = { fields, confidence: 0.8, confidence_label: "high", llm: { used: true, model: "m", error: null } } as unknown as ParsedEmail;
    const p = parsedView(raw)!;
    expect(p.fields).toBe(fields);
    expect(p.confidence).toBe(0.8);
    expect(p.confidence_label).toBe("high");
    expect(p.llm.used).toBe(true);
  });
});

describe("Email Intake page", () => {
  it("reads parsed records through parsedView, not p.fields directly", () => {
    const page = source("app/cds/intake/page.tsx");
    expect(page).toMatch(/parsedView\(e\.parsed\)/);
    expect(page).toMatch(/function Details\(\{ p \}: \{ p: ParsedView \}\)/);
    expect(page).not.toMatch(/\bf\.[a-z_]+\.value/);
  });
});
