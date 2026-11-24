/**
 * Fulfillment method after dispatch (Sarah, CDS, 2026-11-24): CDS changes an order between
 * Shipping and shop pickup after it was sent to the shop, until it is invoiced. Like the unit
 * and location changes (canEditUnitOrLocationOnly), and also not once the shop's bill is in
 * QuickBooks or being created: the method decides the shop's shipping deduction on that bill.
 *
 *  - The page offers "Edit fulfillment" only then (canEditFulfillmentOnly).
 *  - updateWorkOrderFulfillment calls public.cds_set_fulfillment, which enforces the rules in
 *    the database (20261124000000_fulfillment_after_dispatch.sql: a purchased label blocks a
 *    switch to pickup, switching to shipping clears the pickup day and window, history event)
 *    and shows its refusal as is.
 *  - Only shipping and pickup can be chosen; the same method again changes nothing.
 *  - Switching to pickup tells CDS about shipment legs left in Logistics, and that the shop sets
 *    the pickup day and window on an accepted job.
 * The database side is in tests/rls/fulfillment-after-dispatch.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canEditFulfillmentOnly } from "@/components/cds-wo/util";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";

type Wo = { status: string; fulfillment: string; pickup_window: string | null; work_order_internal: { qb_invoice_id: string | null } | null };
let wo: Wo | null;
let shipmentCount: number;
let rpcError: { message: string } | null;
const rpcCalls: [string, Record<string, unknown>][] = [];
const writes: string[] = [];

function query(table: string) {
  let op = "select";
  const result = () => {
    if (table === "work_orders") return { data: wo, error: null };
    if (table === "shipments") return { data: null, count: shipmentCount, error: null };
    return { data: null, error: null };
  };
  const q = {
    select: () => q,
    update: () => ((op = "update"), writes.push(`${table}:${op}`), q),
    insert: async () => (writes.push(`${table}:insert`), { error: null }),
    eq: () => q,
    maybeSingle: async () => result(),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}
const supabase = {
  from: vi.fn((table: string) => query(table)),
  rpc: vi.fn(async (name: string, args: Record<string, unknown>) => (rpcCalls.push([name, args]), { data: null, error: rpcError })),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { updateWorkOrderFulfillment } = await import("@/app/cds/work-orders/[id]/actions");

const form = (v: string) => {
  const fd = new FormData();
  fd.set("fulfillment", v);
  return fd;
};

beforeEach(() => {
  rpcCalls.length = 0;
  writes.length = 0;
  rpcError = null;
  shipmentCount = 0;
  wo = { status: "accepted", fulfillment: "shipping", pickup_window: null, work_order_internal: { qb_invoice_id: null } };
});

describe("canEditFulfillmentOnly", () => {
  it("after dispatch, at every status the shop works in and after the work is done", () => {
    for (const s of ["awaiting_acceptance", "accepted", "picked_up", "in_process", "completed", "delivered", "ready_to_invoice"]) {
      expect(canEditFulfillmentOnly(s, null, false), s).toBe(true);
    }
  });
  it("not in review (the Edit order box has it), not cancelled or invoiced", () => {
    for (const s of ["pending_review", "rejected_by_affiliate", "cancelled", "invoiced"]) {
      expect(canEditFulfillmentOnly(s, null, false), s).toBe(false);
    }
  });
  it("not once the order has its QuickBooks invoice", () => {
    expect(canEditFulfillmentOnly("completed", "QB-1", false)).toBe(false);
  });
  it("not once the shop's bill is in QuickBooks or being created", () => {
    expect(canEditFulfillmentOnly("completed", null, true)).toBe(false);
  });
});

describe("updateWorkOrderFulfillment", () => {
  it("switches to pickup through the database function, which logs the change", async () => {
    const res = await updateWorkOrderFulfillment(WO, {}, form("pickup"));
    expect(rpcCalls).toEqual([["cds_set_fulfillment", { p_work_order: WO, p_fulfillment: "pickup" }]]);
    expect(res.ok).toMatch(/^Fulfillment saved: shop pickup\./);
    // The shop sets the day and window of an accepted job (window Need to coordinate until then).
    expect(res.ok).toMatch(/Need to coordinate/);
    // No direct writes: the function changes the order and logs the event.
    expect(writes).toEqual([]);
  });

  it("before acceptance the shop chooses the pickup day and window when it accepts", async () => {
    wo!.status = "awaiting_acceptance";
    const res = await updateWorkOrderFulfillment(WO, {}, form("pickup"));
    expect(res.ok).toMatch(/when it accepts/);
    expect(res.ok).not.toMatch(/Need to coordinate/);
  });

  it("says when shipment legs without a label are left in Logistics", async () => {
    shipmentCount = 2;
    const res = await updateWorkOrderFulfillment(WO, {}, form("pickup"));
    expect(res.ok).toMatch(/2 shipment legs/);
  });

  it("switches to shipping; the pickup day and window are cleared", async () => {
    wo!.fulfillment = "pickup";
    wo!.pickup_window = "08-10";
    const res = await updateWorkOrderFulfillment(WO, {}, form("shipping"));
    expect(rpcCalls[0][1]).toEqual({ p_work_order: WO, p_fulfillment: "shipping" });
    expect(res.ok).toBe("Fulfillment saved: shipping. The pickup day and window were cleared.");
  });

  it("only shipping or pickup", async () => {
    for (const v of ["supplier_direct", "unspecified", "", "x"]) {
      expect((await updateWorkOrderFulfillment(WO, {}, form(v))).error, v).toMatch(/Choose shipping or shop pickup/);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("the same method again changes nothing", async () => {
    const res = await updateWorkOrderFulfillment(WO, {}, form("shipping"));
    expect(res.ok).toBe("Fulfillment unchanged.");
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses in review, cancelled, invoiced and once the QuickBooks invoice exists", async () => {
    for (const status of ["pending_review", "cancelled", "invoiced"]) {
      wo!.status = status;
      expect((await updateWorkOrderFulfillment(WO, {}, form("pickup"))).error, status).toBeTruthy();
    }
    wo!.status = "completed";
    wo!.work_order_internal = { qb_invoice_id: "QB-1" };
    expect((await updateWorkOrderFulfillment(WO, {}, form("pickup"))).error).toMatch(/invoiced in QuickBooks/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("shows the database's refusal as is (a label to void, the shop's bill)", async () => {
    rpcError = { message: "This order has a shipping label. Void the label in Logistics first, then change the fulfillment to shop pickup." };
    expect((await updateWorkOrderFulfillment(WO, {}, form("pickup"))).error).toMatch(/Void the label/);
    rpcError = { message: "The fulfillment cannot change: the shop's bill is in QuickBooks." };
    expect((await updateWorkOrderFulfillment(WO, {}, form("pickup"))).error).toMatch(/shop's bill/);
  });

  it("refuses an id that is not a work order", async () => {
    expect((await updateWorkOrderFulfillment("nope", {}, form("pickup"))).error).toMatch(/not found/);
  });
});

describe("work order page", () => {
  const page = readFileSync(join(__dirname, "../../src/app/cds/work-orders/[id]/page.tsx"), "utf8");
  it("has Edit fulfillment next to the fulfillment, wired to the action with a confirm", () => {
    expect(page).toMatch(/canEditFulfillmentOnly\(wo\.status, qbInvoiceId,/);
    expect(page).toMatch(/updateWorkOrderFulfillment\.bind\(null, wo\.id\)/);
    expect(page).toMatch(/Edit fulfillment/);
    const at = page.indexOf('<Fact label="Fulfillment">');
    expect(at).toBeGreaterThan(-1);
    const block = page.slice(at, page.indexOf("</Fact>", at));
    expect(block).toMatch(/Edit fulfillment/);
    expect(block).toMatch(/confirmText=/);
  });
});
