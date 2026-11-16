/**
 * Dashboard filters: the status and shop selects and the two checkboxes apply on change;
 * the Search button stays for the text box.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("dashboard filters", () => {
  const page = source("app/cds/page.tsx");
  const wrapper = source("components/cds-wo/SubmitOnChange.tsx");

  it("the wrapper is a client component that submits the form on change", () => {
    expect(wrapper).toMatch(/^"use client";/);
    expect(wrapper).toMatch(/requestSubmit\(\)/);
  });

  it("wraps the selects and checkboxes, not the search box", () => {
    const wrapped = page.match(/<SubmitOnChange>([\s\S]*?)<\/SubmitOnChange>/);
    expect(wrapped).not.toBeNull();
    const inner = wrapped![1];
    expect(inner).toMatch(/name="status"/);
    expect(inner).toMatch(/name="shop"/);
    expect(inner).toMatch(/name="from_shop"/);
    expect(inner).toMatch(/name=\{QUESTION_PARAM\}/);
    expect(inner).not.toMatch(/name="q"/);
  });

  it("keeps the Search button", () => {
    expect(page).toMatch(/type="submit">\s*Search\s*<\/button>/);
  });
});
