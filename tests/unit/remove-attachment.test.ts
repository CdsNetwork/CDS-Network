/**
 * Removing a photo or file from a work order (Sarah, CDS, 2026-11-20). The database decides
 * who may remove what (public.cds_remove_attachment, public.shop_remove_attachment, see
 * tests/rls/remove-attachment.test.ts); the actions call the function first and remove the
 * stored object only after the row is gone. CDS removes the object with its own login; a shop
 * has no storage delete access, so the shop action uses the service role for the object.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireShop: vi.fn(async () => ({ id: "s1", kind: "shop" })),
  requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })),
}));
vi.mock("@/lib/portal-email-send", () => ({ emailCdsAfter: vi.fn() }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const PATH = `${WO}/33333333-3333-4333-8333-333333333333-wrong.png`;

const calls: string[] = [];
let rpcResult: { data: unknown; error: { code?: string; message: string } | null };
const rpc = vi.fn(async (name: string) => {
  calls.push(`rpc ${name}`);
  return rpcResult;
});
const userRemove = vi.fn(async () => {
  calls.push("user storage remove");
  return { data: [], error: null };
});
const adminRemove = vi.fn(async () => {
  calls.push("admin storage remove");
  return { data: [], error: null };
});
const userFrom = vi.fn(() => {
  throw new Error("no direct table access expected");
});
const supabase = { rpc, from: userFrom, storage: { from: vi.fn(() => ({ remove: userRemove })) } };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ storage: { from: vi.fn(() => ({ remove: adminRemove })) } })),
}));

const shop = await import("@/app/shop/actions");
const cds = await import("@/app/cds/work-orders/[id]/actions");
const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

beforeEach(() => {
  calls.length = 0;
  rpc.mockClear();
  userRemove.mockClear();
  adminRemove.mockClear();
  rpcResult = { data: PATH, error: null };
});

describe("shop removes its own file", () => {
  it("calls shop_remove_attachment, then removes the stored object with the service role", async () => {
    const state = await shop.removeAttachment(WO, FILE);
    expect(state.error).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("shop_remove_attachment", { p_work_order: WO, p_attachment: FILE });
    expect(adminRemove).toHaveBeenCalledWith([PATH]);
    expect(calls).toEqual(["rpc shop_remove_attachment", "admin storage remove"]);
  });

  it("shows the database's answer and keeps the stored object when refused", async () => {
    rpcResult = { data: null, error: { code: "P0001", message: "This job can no longer be edited" } };
    expect(await shop.removeAttachment(WO, FILE)).toEqual({ error: "This job can no longer be edited" });
    expect(adminRemove).not.toHaveBeenCalled();
  });

  it("never removes an object outside the work order's folder", async () => {
    rpcResult = { data: "99999999-9999-4999-8999-999999999999/x.png", error: null };
    await shop.removeAttachment(WO, FILE);
    expect(adminRemove).not.toHaveBeenCalled();
  });

  it("refuses ids that are not ids without calling the database", async () => {
    expect((await shop.removeAttachment(WO, "nope")).error).toBe("File not found");
    expect((await shop.removeAttachment("nope", FILE)).error).toBe("Work order not found");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("CDS removes any file", () => {
  it("calls cds_remove_attachment, then removes the stored object with its own login", async () => {
    const state = await cds.removeCdsAttachment(WO, FILE);
    expect(state).toMatchObject({ ok: "File removed." });
    expect(rpc).toHaveBeenCalledWith("cds_remove_attachment", { p_work_order: WO, p_attachment: FILE });
    expect(userRemove).toHaveBeenCalledWith([PATH]);
    expect(calls).toEqual(["rpc cds_remove_attachment", "user storage remove"]);
  });

  it("shows the database's answer and keeps the stored object when refused", async () => {
    rpcResult = { data: null, error: { code: "P0002", message: "File not found" } };
    expect(await cds.removeCdsAttachment(WO, FILE)).toEqual({ error: "File not found" });
    expect(userRemove).not.toHaveBeenCalled();
  });
});

describe("the remove buttons", () => {
  it("CDS offers Remove on every file, with a confirm naming the file", () => {
    const page = src("app/cds/work-orders/[id]/page.tsx");
    expect(page).not.toMatch(/cdsCanDelete/);
    expect(page).toMatch(/removeCdsAttachment\.bind\(null, wo\.id, a\.id\)/);
    expect(page).toMatch(/confirmText=\{cdsRemoveConfirm\(a\.file_name, photoLeftFor\(/);
  });

  it("the shop page offers Remove only where shopCanRemove allows, with a confirm naming the file", () => {
    const detail = src("components/shop/JobDetail.tsx");
    expect(detail).toMatch(/a\.can_remove &&/);
    expect(detail).toMatch(/removeAttachment\.bind\(null, id, a\.id\)/);
    expect(detail).toMatch(/confirmText=\{`Remove \$\{a\.file_name\}\?/);
    const data = src("app/shop/data.ts");
    expect(data).toMatch(/can_remove: shopCanRemove\(/);
  });
});
