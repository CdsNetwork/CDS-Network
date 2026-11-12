/**
 * "Condemned" replaces "Failed" (Sarah, CDS, 2026-11-12: "failed" and "condemned" mean the
 * same thing for CDS). A DPF, DOC or SCR is Cleaned Successfully or Condemned; an EGR cooler
 * is Pass or Condemned. Nothing offers or shows "Failed" any more, and the shop action refuses
 * it. The database rule is in tests/rls/condemned-replaces-failed.test.ts.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireShop: vi.fn(async () => ({ id: "s1", kind: "shop" })) }));
const emailCdsAfter = vi.fn();
vi.mock("@/lib/portal-email-send", () => ({ emailCdsAfter }));
const rpc = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { saveComponent } = await import("@/app/shop/actions");
const { COMPONENT_RESULT_LABEL } = await import("@/lib/format");
const { failedMark } = await import("@/components/cds-wo/shop-updates");
const { measurementDescription } = await import("@/lib/qbo/invoice");
const { buildPortalEmail } = await import("@/lib/portal-email");

const WO = "11111111-1111-4111-8111-111111111111";
const COMP = "22222222-2222-4222-8222-222222222222";
const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  rpc.mockClear();
  emailCdsAfter.mockClear();
});

describe("result choices on the shop's component card", () => {
  const card = src("components/shop/ComponentCard.tsx");

  it("offer no Failed or Fail option", () => {
    expect(card).not.toMatch(/value="failed"/);
    expect(card).not.toMatch(/>Fail(ed)?</);
  });

  it("offer Pass or Condemned for an EGR, and Cleaned Successfully or Condemned otherwise", () => {
    expect(card).toMatch(/<option value="passed">Pass<\/option>\s*<option value="condemned">Condemned<\/option>/);
    expect(card).toMatch(/<option value="cleaned">Cleaned Successfully<\/option>\s*<option value="condemned">Condemned<\/option>/);
  });
});

describe("the shop's saveComponent action", () => {
  const fields = (type: string, result: string) => ({
    component_type: type,
    manufacturer: "Test",
    part_number: "PN",
    serial_number: "SN",
    result,
    result_note: "Cracked",
  });

  it("refuses Failed, for an EGR and for a filter", async () => {
    for (const type of ["EGR", "DPF"]) {
      const res = await saveComponent(WO, COMP, {}, form(fields(type, "failed")));
      expect(res.error, type).toMatch(/Condemned/);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("saves a condemned EGR with its reason and emails CDS", async () => {
    const res = await saveComponent(WO, COMP, {}, form(fields("EGR", "condemned")));
    expect(res.error).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("shop_save_component", expect.objectContaining({ p_result: "condemned", p_result_note: "Cracked" }));
    expect(emailCdsAfter).toHaveBeenCalledWith("failed", WO, COMP);
  });
});

describe("labels", () => {
  it("have no Failed result", () => {
    expect(Object.keys(COMPONENT_RESULT_LABEL).sort()).toEqual(["cleaned", "condemned", "passed"]);
  });

  it("the CDS list mark says Condemned", () => {
    expect(failedMark([{ result: "cleaned" }, { result: "condemned" }])).toBe("Condemned");
    expect(failedMark([{ result: "cleaned" }])).toBeNull();
  });

  it("a condemned EGR reads Condemned on the QuickBooks invoice", () => {
    const egr = {
      componentType: "EGR",
      seq: 1,
      manufacturer: "Volvo",
      partNumber: "EGR-9",
      serialNumber: "SN-3",
      dpBefore: null,
      dpAfter: null,
      weightBeforeG: null,
      weightAfterG: null,
      weightRemovedG: null,
      result: "condemned",
    } as Parameters<typeof measurementDescription>[0];
    expect(measurementDescription(egr)).toBe("Manufacturer: Volvo\nPart Number: EGR-9\nSerial Number: SN-3\nResult: Condemned");
  });

  it("the CDS email says condemned when no result label is passed", () => {
    const email = buildPortalEmail("failed", { woNumber: 101924, shop: "Enviromotive", component: "DPF" } as Parameters<typeof buildPortalEmail>[1]);
    expect(email.subject).toMatch(/DPF marked Condemned by Enviromotive/);
  });

  it("no screen shows Fail or Failed for a component result", () => {
    for (const path of [
      "components/shop/JobDetail.tsx",
      "app/cds/affiliate-view/ShopPreview.tsx",
      "app/cds/work-orders/[id]/page.tsx",
      "lib/sheets/columns.ts",
      "lib/qbo/invoice.ts",
      "components/shop/types.ts",
    ]) {
      const text = src(path);
      expect(text, path).not.toMatch(/result === "failed"|"failed" \| "condemned"|failed: "Fail/);
    }
  });
});
