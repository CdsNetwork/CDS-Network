/**
 * Manufacturer is a list (Sarah, CDS, 2026-11-20): the shop picks CUMMINS, DETROIT, VOLVO,
 * ISUZU, NAVISTAR, INTERNATIONAL or N/A instead of typing it. A component saved before keeps
 * its typed value: the card shows it as the selected extra choice, so saving does not wipe it.
 * The database rule (shop_save_component) is in tests/rls/component-manufacturer.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireShop: vi.fn(async () => ({ id: "s1", kind: "shop" })) }));
vi.mock("@/lib/portal-email-send", () => ({ emailCdsAfter: vi.fn() }));
const rpc = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { saveComponent } = await import("@/app/shop/actions");
const { MANUFACTURERS, manufacturerAllowed, manufacturerOptions } = await import("@/lib/manufacturers");

const WO = "11111111-1111-4111-8111-111111111111";
const COMP = "22222222-2222-4222-8222-222222222222";
const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ component_type: "DOC", part_number: "PN", serial_number: "SN", result: "cleaned", ...fields })) {
    f.set(k, v);
  }
  return f;
};

beforeEach(() => rpc.mockClear());

describe("the manufacturer list", () => {
  it("is exactly the seven choices, in Sarah's order, all caps", () => {
    expect([...MANUFACTURERS]).toEqual(["CUMMINS", "DETROIT", "VOLVO", "ISUZU", "NAVISTAR", "INTERNATIONAL", "N/A"]);
  });

  it("offers an older typed value first, as it is, so it stays selected", () => {
    expect(manufacturerOptions(null)).toEqual([...MANUFACTURERS]);
    expect(manufacturerOptions("")).toEqual([...MANUFACTURERS]);
    expect(manufacturerOptions("VOLVO")).toEqual([...MANUFACTURERS]);
    expect(manufacturerOptions("Freightliner")).toEqual(["Freightliner", ...MANUFACTURERS]);
  });

  it("allows a choice from the list, an empty value, or the value the component already has", () => {
    expect(manufacturerAllowed("DETROIT", null)).toBe(true);
    expect(manufacturerAllowed("", null)).toBe(true);
    expect(manufacturerAllowed("Freightliner", "Freightliner")).toBe(true);
    expect(manufacturerAllowed("Freightliner", null)).toBe(false);
    expect(manufacturerAllowed("detroit", null)).toBe(false);
    expect(manufacturerAllowed("Other", "Freightliner")).toBe(false);
  });
});

describe("the shop's saveComponent action", () => {
  it("saves a manufacturer from the list", async () => {
    const res = await saveComponent(WO, COMP, {}, form({ manufacturer: "CUMMINS" }));
    expect(res.error).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("shop_save_component", expect.objectContaining({ p_manufacturer: "CUMMINS" }));
  });

  it("refuses a typed manufacturer that is not on the list", async () => {
    const res = await saveComponent(WO, COMP, {}, form({ manufacturer: "Freightliner" }));
    expect(res.error).toMatch(/Choose the manufacturer from the list/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps the older value the component was saved with", async () => {
    const res = await saveComponent(WO, COMP, {}, form({ manufacturer: "Freightliner", manufacturer_saved: "Freightliner" }));
    expect(res.error).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("shop_save_component", expect.objectContaining({ p_manufacturer: "Freightliner" }));
  });

  it("still saves a component without a manufacturer yet (filled in later, required at completion)", async () => {
    const res = await saveComponent(WO, COMP, {}, form({ manufacturer: "" }));
    expect(res.error).toBeUndefined();
  });
});

describe("the component card", () => {
  const card = src("components/shop/ComponentCard.tsx");
  it("is a dropdown built from the list, with the saved value kept", () => {
    expect(card).toMatch(/<select[^>]*name="manufacturer"/);
    expect(card).toMatch(/manufacturerOptions\(c\.manufacturer\)/);
    expect(card).toMatch(/name="manufacturer_saved"/);
    expect(card).not.toMatch(/\["manufacturer", "Manufacturer", c\.manufacturer\]/);
  });
});

describe("the database", () => {
  it("shop_save_component checks the list, keeping a value the component already has", () => {
    const dir = join(__dirname, "../../supabase/migrations");
    const files = readdirSync(dir).filter((f) => /function public\.shop_save_component\(/.test(readFileSync(join(dir, f), "utf8")));
    const sql = readFileSync(join(dir, files.sort().at(-1)!), "utf8");
    for (const m of MANUFACTURERS) expect(sql).toContain(`'${m}'`);
    expect(sql).toMatch(/Choose the manufacturer from the list/);
  });
});
