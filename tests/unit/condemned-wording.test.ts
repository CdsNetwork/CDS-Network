import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Sarah, CDS, 2026-11-12: "failed" and "condemned" mean the same; use only "condemned" everywhere.
const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

describe("no Failure wording left for components", () => {
  it("the shop card asks for a condemn reason", () => {
    expect(src("components/shop/ComponentCard.tsx")).not.toMatch(/Failure \/ Condemn/);
    expect(src("components/shop/ComponentCard.tsx")).toMatch(/Condemn Reason/);
  });
  it("the New from shop tooltip no longer mentions failures or accepting", () => {
    const page = src("app/cds/page.tsx");
    expect(page).not.toMatch(/a file or a failure/);
    expect(page).not.toMatch(/The shop accepted, set the pickup ETA/);
  });
});
