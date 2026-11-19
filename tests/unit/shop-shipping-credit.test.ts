/**
 * "Shipping credit from shop" per order (Sarah, CDS, 2026-11-19): CDS turns the $15 per part
 * shop shipping credit off (or back on) on the work order page. The database drops the
 * deduction and locks the flag once the shop's bill is in QuickBooks
 * (20261119210000_shop_shipping_credit_toggle.sql); the action saves it and logs a CDS-only
 * event, and the page shows it read-only while locked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

type Call = { table: string; op: string; row?: unknown; filters: [string, unknown][] };
const calls: Call[] = [];
let current: { shop_shipping_credit: boolean } | null;
let updateError: { message: string } | null;

function query(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  calls.push(call);
  const result = () => {
    if (call.op === "update") return { data: updateError ? null : [{ work_order_id: "w" }], error: updateError };
    if (table === "work_order_internal") return { data: current, error: null };
    return { data: null, error: null };
  };
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => (call.filters.push([col, v]), q),
    update: (row: unknown) => ((call.op = "update"), (call.row = row), q),
    insert: async (row: unknown) => ((call.op = "insert"), (call.row = row), { error: null }),
    maybeSingle: async () => result(),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}
const supabase = { rpc: vi.fn(), from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { setShopShippingCredit } = await import("@/app/cds/work-orders/[id]/actions");
const { shippingCreditLock, SHIPPING_CREDIT_HELP } = await import("@/lib/shop-deductions");

const WO = "11111111-1111-4111-8111-111111111111";
const form = (on: boolean) => {
  const f = new FormData();
  if (on) f.set("shop_shipping_credit", "on");
  return f;
};

beforeEach(() => {
  calls.length = 0;
  current = { shop_shipping_credit: true };
  updateError = null;
});

describe("setShopShippingCredit", () => {
  it("turns the credit off on the CDS-only order row and logs a CDS-only event", async () => {
    const res = await setShopShippingCredit(WO, {}, form(false));
    expect(res).toMatchObject({ ok: expect.stringMatching(/off/) });
    const update = calls.find((c) => c.op === "update");
    expect(update).toMatchObject({ table: "work_order_internal", row: { shop_shipping_credit: false } });
    expect(update?.filters).toContainEqual(["work_order_id", WO]);
    const event = calls.find((c) => c.table === "work_order_events" && c.op === "insert");
    expect(event?.row).toMatchObject({ work_order_id: WO, actor_id: "u1", shop_visible: false });
    expect((event?.row as { message: string }).message).toBe("Shipping credit from shop turned off");
  });

  it("turns it back on", async () => {
    current = { shop_shipping_credit: false };
    const res = await setShopShippingCredit(WO, {}, form(true));
    expect(res).toMatchObject({ ok: expect.stringMatching(/on/) });
    expect(calls.find((c) => c.op === "update")?.row).toEqual({ shop_shipping_credit: true });
    const event = calls.find((c) => c.table === "work_order_events" && c.op === "insert");
    expect((event?.row as { message: string }).message).toBe("Shipping credit from shop turned on");
  });

  it("does nothing when the value is unchanged", async () => {
    const res = await setShopShippingCredit(WO, {}, form(true));
    expect(res).toMatchObject({ ok: expect.any(String) });
    expect(calls.some((c) => c.op === "update" || c.op === "insert")).toBe(false);
  });

  it("shows the database's refusal once the shop's bill is in QuickBooks, and logs nothing", async () => {
    updateError = { message: "The shipping credit cannot change: the shop's bill is in QuickBooks." };
    const res = await setShopShippingCredit(WO, {}, form(false));
    expect(res).toEqual({ error: updateError.message });
    expect(calls.some((c) => c.table === "work_order_events")).toBe(false);
  });

  it("refuses an unknown work order", async () => {
    expect(await setShopShippingCredit("nope", {}, form(false))).toMatchObject({ error: "Work order not found." });
    current = null;
    expect(await setShopShippingCredit(WO, {}, form(false))).toMatchObject({ error: "Work order not found." });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });
});

describe("shippingCreditLock", () => {
  it("is open before a bill exists or after a failed one", () => {
    expect(shippingCreditLock(null, null)).toBeNull();
    expect(shippingCreditLock(null, { kind: "none" })).toBeNull();
    expect(shippingCreditLock(null, { kind: "blocked", problems: [], lastError: null })).toBeNull();
  });

  it("is locked once the shop's bill is in QuickBooks, by either record", () => {
    expect(shippingCreditLock("123", null)).toMatch(/bill is in QuickBooks/);
    expect(
      shippingCreditLock(null, { kind: "created", billId: "9", number: null, total: null, at: null, changedTotal: null, division: null }),
    ).toMatch(/bill is in QuickBooks/);
  });

  it("is locked while the bill is being created", () => {
    expect(shippingCreditLock(null, { kind: "creating" })).toMatch(/being created/);
  });

  it("has the help text CDS asked for", () => {
    expect(SHIPPING_CREDIT_HELP).toBe("Turn off when the shop does not give a shipping credit on this order, for example NOx sensors.");
  });
});
