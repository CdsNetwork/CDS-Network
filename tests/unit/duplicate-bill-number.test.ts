/**
 * Duplicate shop bill numbers (Sarah, CDS, 2026-11-23: "Can we make the portal reject an
 * affiliate bill number that is already in QB? QBO always gives a warning if there is a bill
 * number already processed under an account, so block the affiliate from submitting a
 * duplicate bill #").
 *
 * At completion, before public.shop_complete_work_order is called (QuickBooks stays out of the
 * database transaction):
 *   * the shop is linked to a QuickBooks vendor and QuickBooks has a bill from that vendor with
 *     that number (not the portal's own bill for this order): refused with a clear message;
 *   * QuickBooks is not connected, the lookup fails or takes too long: not blocked, logged;
 *   * no vendor link (or no number typed): QuickBooks is not asked.
 * The portal-side rule (another work order of the same shop has the number) is in the database
 * and works without QuickBooks: tests/rls/duplicate-bill-number.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { billNumberInQuickBooks, type BillNumberDeps } from "@/lib/bill-number-check";
import type { FoundBill } from "@/lib/qbo/bill-run";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireShop: vi.fn(async () => ({ id: "s1", kind: "shop" })) }));
vi.mock("@/lib/portal-email-send", () => ({ emailCdsAfter: vi.fn() }));
const createShopBillAfter = vi.fn();
vi.mock("@/lib/qbo/bill-server", () => ({ createShopBillAfter, createShopBill: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const quickBooksBillNumberError = vi.fn<(woId: string, ref: string) => Promise<string | null>>();
vi.mock("@/lib/bill-number-check-server", () => ({ quickBooksBillNumberError }));

let rpcError: { message: string; code?: string } | null = null;
const rpc = vi.fn(async () => ({ data: null, error: rpcError }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));

const { completeJob } = await import("@/app/shop/actions");

const WO = "11111111-1111-4111-8111-111111111111";
const SHOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VENDOR = { id: "57", name: "Example Diesel Shop LLC" };
const bill = (over: Partial<FoundBill> = {}): FoundBill => ({ Id: "901", DocNumber: "INV-7781", VendorRef: { value: "57" }, PrivateNote: "Portal WO-104001", ...over });

function deps(over: Partial<BillNumberDeps> = {}): BillNumberDeps & { logged: string[]; asked: string[] } {
  const logged: string[] = [];
  const asked: string[] = [];
  return {
    logged,
    asked,
    vendorFor: async () => VENDOR,
    findBills: async (doc) => {
      asked.push(doc);
      return [bill()];
    },
    log: (note) => {
      logged.push(note);
    },
    timeoutMs: 50,
    ...over,
  };
}
const input = (ref: string) => ({ ref, affiliateId: SHOP, woNumber: 104777 });

describe("billNumberInQuickBooks", () => {
  it("refuses a number QuickBooks already has from the shop's vendor", async () => {
    const d = deps();
    expect(await billNumberInQuickBooks(d, input(" INV-7781 "))).toBe(
      "Bill number INV-7781 is already in QuickBooks for your shop. Check the number and try again.",
    );
    expect(d.asked).toEqual(["INV-7781"]);
  });

  it("matches the number in any case", async () => {
    expect(await billNumberInQuickBooks(deps(), input("inv-7781"))).toMatch(/already in QuickBooks/);
  });

  it("ignores a bill with that number from another vendor", async () => {
    const d = deps({ findBills: async () => [bill({ VendorRef: { value: "99" } })] });
    expect(await billNumberInQuickBooks(d, input("INV-7781"))).toBeNull();
  });

  it("ignores the portal's own bill for this order", async () => {
    const d = deps({ findBills: async () => [bill({ PrivateNote: "Portal WO-104777 | Shop invoice INV-7781" })] });
    expect(await billNumberInQuickBooks(d, input("INV-7781"))).toBeNull();
  });

  it("asks with the bill number the portal would send (QuickBooks keeps 21 characters)", async () => {
    const d = deps({ findBills: async (doc) => (d.asked.push(doc), []) });
    await billNumberInQuickBooks(d, input("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
    expect(d.asked).toEqual(["ABCDEFGHIJKLMNOPQRSTU"]);
  });

  it("does not ask QuickBooks when the shop has no vendor link or no number was typed", async () => {
    const noVendor = deps({ vendorFor: async () => null });
    expect(await billNumberInQuickBooks(noVendor, input("INV-7781"))).toBeNull();
    expect(noVendor.asked).toEqual([]);
    const empty = deps();
    expect(await billNumberInQuickBooks(empty, input("  "))).toBeNull();
    expect(empty.asked).toEqual([]);
  });

  it("does not block when QuickBooks is not connected or the lookup fails, and logs it", async () => {
    const d = deps({
      findBills: async () => {
        throw new Error("QuickBooks is not connected. Connect it in Admin > Settings.");
      },
    });
    expect(await billNumberInQuickBooks(d, input("INV-7781"))).toBeNull();
    expect(d.logged.join(" ")).toMatch(/not connected/);
  });

  it("does not block when the vendor link cannot be read, and logs it", async () => {
    const d = deps({
      vendorFor: async () => {
        throw new Error("db down");
      },
    });
    expect(await billNumberInQuickBooks(d, input("INV-7781"))).toBeNull();
    expect(d.logged.join(" ")).toMatch(/db down/);
  });

  it("does not make the shop wait on a slow QuickBooks", async () => {
    const d = deps({ findBills: () => new Promise(() => {}) });
    expect(await billNumberInQuickBooks(d, input("INV-7781"))).toBeNull();
    expect(d.logged.join(" ")).toMatch(/did not answer/);
  });
});

describe("completeJob", () => {
  const form = (ref: string) => {
    const fd = new FormData();
    fd.set("invoice_ref", ref);
    return fd;
  };

  beforeEach(() => {
    rpcError = null;
    rpc.mockClear();
    createShopBillAfter.mockClear();
    quickBooksBillNumberError.mockReset();
    quickBooksBillNumberError.mockResolvedValue(null);
  });

  it("refuses a number QuickBooks already has, before the database is asked", async () => {
    quickBooksBillNumberError.mockResolvedValue("Bill number INV-7781 is already in QuickBooks for your shop. Check the number and try again.");
    const r = await completeJob(WO, {}, form("INV-7781"));
    expect(r.error).toBe("Bill number INV-7781 is already in QuickBooks for your shop. Check the number and try again.");
    expect(quickBooksBillNumberError).toHaveBeenCalledWith(WO, "INV-7781");
    expect(rpc).not.toHaveBeenCalled();
    expect(createShopBillAfter).not.toHaveBeenCalled();
  });

  it("completes when QuickBooks has no such bill", async () => {
    const r = await completeJob(WO, {}, form("INV-7782"));
    expect(r.error).toBeFalsy();
    expect(rpc).toHaveBeenCalledWith("shop_complete_work_order", { p_work_order: WO, p_invoice_ref: "INV-7782" });
  });

  it("shows the database's refusal of a number another order of the shop has", async () => {
    rpcError = { message: "Bill number INV-7781 is already used on WO-104001 for your shop. Check the number and try again.", code: "P0001" };
    const r = await completeJob(WO, {}, form("INV-7781"));
    expect(r.error).toMatch(/already used on WO-104001/);
  });

  it("an in-house order left empty is not checked in QuickBooks (it gets IN-HOUSE-<wo>)", async () => {
    await completeJob(WO, {}, form(""));
    expect(quickBooksBillNumberError).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalled();
  });
});

describe("database: shop_complete_work_order", () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
  const body = (sql: string) => {
    const start = sql.indexOf("create or replace function public.shop_complete_work_order");
    return sql
      .slice(start, sql.indexOf("end $$;", start))
      .split("\n")
      .map((l) => l.replace(/--.*$/, "").trim())
      .filter(Boolean);
  };
  const latest = readdirSync(dir)
    .sort()
    .filter((f) => /create or replace function public\.shop_complete_work_order/.test(read(f)))
    .at(-1)!;

  it("the latest definition is 20261123010000 and only adds the duplicate check to 20261119090000", () => {
    expect(latest).toBe("20261123010000_duplicate_bill_number.sql");
    const before = body(read("20261119090000_parts_only_no_measurements.sql"));
    const after = body(read(latest));
    const added = after.filter((l) => !before.includes(l));
    expect(before.filter((l) => !after.includes(l))).toEqual([]);
    expect(added.join("\n")).toMatch(/lower\(btrim\(o\.affiliate_invoice_ref\)\) = lower\(ref\)/);
    expect(added.join("\n")).toMatch(/o\.affiliate_id = wo\.affiliate_id and o\.id <> wo\.id and o\.status <> 'cancelled'/);
    // The check runs after the in-house default and the length check, before anything is written.
    const at = (re: RegExp) => after.findIndex((l) => re.test(l));
    expect(at(/check_length\(ref, 100\)/)).toBeLessThan(at(/select o\.wo_number into dup_wo/));
    expect(at(/select o\.wo_number into dup_wo/)).toBeLessThan(at(/^update public\.work_orders/));
  });

  it("keeps the grants", () => {
    const sql = read(latest);
    expect(sql).toMatch(/grant execute on function public\.shop_complete_work_order\(uuid, text\) to authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.shop_complete_work_order\(uuid, text\) to service_role;/);
  });
});
