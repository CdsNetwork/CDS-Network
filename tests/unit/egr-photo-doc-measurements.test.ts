/**
 * Sarah, CDS, 2026-11-17:
 *  - A condemned EGR cooler needs no photo (other condemned components still do).
 *  - DOC measurements are optional: only a DPF that is not condemned needs pressure and
 *    weight before and after (SCR was already optional).
 *  - Blank measurements of a DOC or SCR show "N/A" instead of a dash.
 * The completion rule in the database is in tests/rls/egr-photo-doc-measurements.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { condemnedPhotoRequired, measurementsRequired } from "@/components/shop/types";
import { measurementText } from "@/lib/format";

const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
const migrations = join(__dirname, "../../supabase/migrations");

describe("shop component rules", () => {
  it("only a DPF that is not condemned needs measurements", () => {
    expect(measurementsRequired("DPF", "cleaned")).toBe(true);
    expect(measurementsRequired("DPF", null)).toBe(true);
    expect(measurementsRequired("DPF", "condemned")).toBe(false);
    for (const t of ["DOC", "SCR", "EGR"] as const) expect(measurementsRequired(t, "cleaned"), t).toBe(false);
  });

  it("a condemned part needs a photo, except an EGR cooler", () => {
    expect(condemnedPhotoRequired("DPF", "condemned")).toBe(true);
    expect(condemnedPhotoRequired("DOC", "condemned")).toBe(true);
    expect(condemnedPhotoRequired("SCR", "condemned")).toBe(true);
    expect(condemnedPhotoRequired("EGR", "condemned")).toBe(false);
    expect(condemnedPhotoRequired("DPF", "cleaned")).toBe(false);
  });

  it("the component card asks for the photo only when it is required", () => {
    const card = src("components/shop/ComponentCard.tsx");
    expect(card).toMatch(/condemnedPhotoRequired\(c\.component_type, result\)/);
    expect(card).toMatch(/No photo needed for a condemned EGR cooler/);
  });

  it("the shop's component help text says DOC measurements are optional", () => {
    const detail = src("components/shop/JobDetail.tsx");
    expect(detail).not.toMatch(/DPF and DOC need pressure and weight/);
    expect(detail).toMatch(/DOC and SCR measurements are optional/);
  });
});

describe("measurementText", () => {
  it("shows N/A for a blank DOC or SCR reading, a dash for a blank DPF one", () => {
    expect(measurementText("DOC", null)).toBe("N/A");
    expect(measurementText("SCR", null, " g")).toBe("N/A");
    expect(measurementText("DPF", null)).toBe("-");
    expect(measurementText("DOC", 2.5)).toBe("2.5");
    expect(measurementText("DPF", 15250, " g")).toBe("15250 g");
  });

  it("is used on the CDS work order page, the shop job page and the shop preview", () => {
    expect(src("app/cds/work-orders/[id]/page.tsx")).toMatch(/measurementText\(c\.component_type, c\.dp_before\)/);
    expect(src("components/shop/JobDetail.tsx")).toMatch(/measurementText\(c\.component_type, c\.dp_before\)/);
    expect(src("app/cds/affiliate-view/ShopPreview.tsx")).toMatch(/measurementText\(c\.component_type, c\.dp_before\)/);
  });
});

describe("completion rule in the database", () => {
  const latest = () => {
    const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
    const withFn = files.filter((f) => /function public\.shop_complete_work_order\(/.test(readFileSync(join(migrations, f), "utf8")));
    return { name: withFn.at(-1)!, sql: readFileSync(join(migrations, withFn.at(-1)!), "utf8") };
  };
  it("is redefined by 20261119040000_egr_no_photo_doc_optional.sql", () => {
    expect(latest().name).toBe("20261119040000_egr_no_photo_doc_optional.sql");
  });
  it("asks for measurements on a DPF only and skips the photo for an EGR cooler", () => {
    const { sql } = latest();
    expect(sql).toMatch(/if c\.component_type = 'DPF' and c\.result <> 'condemned'/);
    expect(sql).toMatch(/if c\.result = 'condemned' and c\.component_type <> 'EGR' and not exists/);
    expect(sql).not.toMatch(/in \('DPF', 'DOC'\)/);
  });
});
