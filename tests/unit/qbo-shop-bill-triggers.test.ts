/**
 * M3: when the shop's bill is created. The shop completing the job and CDS entering a shop
 * rate (the last TBD one) start the automatic run after the answer; a refused completion or
 * rate does not. CDS's Create bill / Retry button runs it at once and shows the result.
 * The run itself (one bill only, ready or not) is tested in qbo-shop-bill-run.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireShop: vi.fn(async () => ({ id: "s1", kind: "shop" })),
  requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })),
}));
vi.mock("@/lib/portal-email-send", () => ({ emailCdsAfter: vi.fn() }));
const createShopBillAfter = vi.fn();
const createShopBill = vi.fn();
vi.mock("@/lib/qbo/bill-server", () => ({ createShopBillAfter, createShopBill }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

let rpcError: { message: string; code?: string } | null = null;
const rpc = vi.fn(async () => ({ data: null, error: rpcError }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));

const shop = await import("@/app/shop/actions");
const cds = await import("@/app/cds/work-orders/[id]/actions");

const WO = "11111111-1111-4111-8111-111111111111";
const LINE = "22222222-2222-4222-8222-222222222222";
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  rpcError = null;
  createShopBillAfter.mockClear();
  createShopBill.mockReset();
  rpc.mockClear();
});

describe("automatic shop bill", () => {
  it("starts after the shop completes the job", async () => {
    const r = await shop.completeJob(WO, {}, form({ invoice_ref: "INV-7781" }));
    expect(r.error).toBeFalsy();
    expect(createShopBillAfter).toHaveBeenCalledWith(WO);
  });

  it("does not start when the completion is refused", async () => {
    rpcError = { message: "Add at least one component", code: "P0001" };
    await shop.completeJob(WO, {}, form({ invoice_ref: "INV-7781" }));
    expect(createShopBillAfter).not.toHaveBeenCalled();
  });

  it("starts after CDS enters a shop rate, not when the rate is refused", async () => {
    await cds.setLineShopRate(WO, LINE, {}, form({ amount: "300" }));
    expect(createShopBillAfter).toHaveBeenCalledWith(WO);
    createShopBillAfter.mockClear();
    rpcError = { message: "The shop rate cannot change once the work order is invoiced" };
    await cds.setLineShopRate(WO, LINE, {}, form({ amount: "300" }));
    expect(createShopBillAfter).not.toHaveBeenCalled();
  });
});

describe("Create bill / Retry", () => {
  it("runs at once and shows the bill number", async () => {
    createShopBill.mockResolvedValue({ status: "created", message: "QuickBooks bill INV-7781 created ($250.00)." });
    const r = await cds.createQuickBooksBill(WO);
    expect(createShopBill).toHaveBeenCalledWith(WO, "manual");
    expect(r).toMatchObject({ ok: "QuickBooks bill INV-7781 created ($250.00)." });
  });

  it("shows QuickBooks's reason when it fails", async () => {
    createShopBill.mockResolvedValue({ status: "failed", message: "QuickBooks refused the bill: Invalid account" });
    expect(await cds.createQuickBooksBill(WO)).toEqual({ error: "QuickBooks refused the bill: Invalid account" });
  });

  it("refuses a bad work order id without calling anything", async () => {
    expect(await cds.createQuickBooksBill("x")).toEqual({ error: "Work order not found." });
    expect(createShopBill).not.toHaveBeenCalled();
  });
});
