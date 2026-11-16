/**
 * CDS pages show an error screen inside the CDS layout and a loading state, and no
 * "Milestone 2" text is left on the create form.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const path = (p: string) => new URL(`../../src/${p}`, import.meta.url);
const source = (p: string) => readFileSync(path(p), "utf8");

describe("CDS error and loading screens", () => {
  it("error.tsx offers Try again and a way back, without the raw message", () => {
    expect(existsSync(path("app/cds/error.tsx"))).toBe(true);
    const err = source("app/cds/error.tsx");
    expect(err).toMatch(/^"use client";/);
    expect(err).toMatch(/onClick=\{\(\) => reset\(\)\}/);
    expect(err).toMatch(/This page could not load/);
    expect(err).toMatch(/href="\/cds"/);
    expect(err).not.toMatch(/error\.message/);
  });

  it.each(["app/cds/loading.tsx", "app/cds/work-orders/[id]/loading.tsx"])("%s shows a status", (file) => {
    expect(existsSync(path(file))).toBe(true);
    const src = source(file);
    expect(src).toMatch(/role="status"/);
    expect(src).toMatch(/aria-live="polite"/);
  });
});

describe("Milestone 2 leftovers", () => {
  it("the shipping hint says labels are made on the work order page", () => {
    const form = source("components/cds-wo/NewWorkOrderForm.tsx");
    expect(form).not.toMatch(/Milestone 2/);
    expect(form).toMatch(/Make the shipping labels on the work order page after you create it\./);
  });

  it("M2Button is gone", () => {
    expect(source("components/cds-admin/ActionForm.tsx")).not.toMatch(/M2Button/);
  });
});
