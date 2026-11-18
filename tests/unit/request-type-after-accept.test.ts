/**
 * Request type after the shop accepted (Sarah, CDS, 2026-11-18): when a filter fails and a part
 * is sold instead, CDS switches the order from Service to Parts Only so the shop is not asked
 * for measurements. The full Edit order box is only there while the order is in review, so CDS
 * now changes just the request type while the shop still has the job (awaiting acceptance,
 * accepted, picked up, in process). Once the shop completed it, or the order is invoiced or
 * cancelled, it is fixed. The change is logged on the order history as a CDS edit (CDS only,
 * like the other order edits: shop pages show no order history); the shop's job page follows
 * the new type at once (partsSale, src/app/shop/data.ts), so no measurements are asked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canEditRequestTypeOnly } from "@/components/cds-wo/util";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";

type Call = { table: string; op: string; filters: [string, unknown][]; row?: Record<string, unknown> };
const calls: Call[] = [];
let wo: { status: string; request_type: string } | null;
let updateError: { message: string } | null;

function query(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  calls.push(call);
  const result = () => {
    if (call.op === "update") return { data: [{ id: WO }], error: updateError };
    if (table === "work_orders") return { data: wo, error: null };
    return { data: null, error: null };
  };
  const q = {
    select: () => q,
    update: (row: Record<string, unknown>) => ((call.op = "update"), (call.row = row), q),
    insert: async (row: Record<string, unknown>) => ((call.op = "insert"), (call.row = row), { error: null }),
    eq: (col: string, v: unknown) => (call.filters.push([col, v]), q),
    maybeSingle: async () => result(),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}
const supabase = { from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { updateWorkOrderRequestType } = await import("@/app/cds/work-orders/[id]/actions");

const form = (type: string) => {
  const fd = new FormData();
  fd.set("request_type", type);
  return fd;
};
const updates = () => calls.filter((c) => c.table === "work_orders" && c.op === "update");
const events = () => calls.filter((c) => c.table === "work_order_events" && c.op === "insert");

beforeEach(() => {
  calls.length = 0;
  updateError = null;
  wo = { status: "in_process", request_type: "service" };
});

describe("canEditRequestTypeOnly", () => {
  it("offers the request type change while the shop has the job", () => {
    for (const s of ["awaiting_acceptance", "accepted", "picked_up", "in_process"]) expect(canEditRequestTypeOnly(s), s).toBe(true);
  });
  it("not in review (the Edit order box has it), and not once completed, invoiced or cancelled", () => {
    for (const s of ["pending_review", "rejected_by_affiliate", "completed", "delivered", "ready_to_invoice", "invoiced", "cancelled"]) {
      expect(canEditRequestTypeOnly(s), s).toBe(false);
    }
  });
});

describe("updateWorkOrderRequestType", () => {
  it("switches an accepted service order to parts only, changing nothing else, and logs it", async () => {
    wo = { status: "accepted", request_type: "service" };
    const res = await updateWorkOrderRequestType(WO, {}, form("parts_only"));
    expect(res).toMatchObject({ ok: "Request type saved." });
    const [u] = updates();
    expect(u.row).toEqual({ request_type: "parts_only" });
    expect(u.filters).toContainEqual(["id", WO]);
    const [event] = events();
    expect(event.row).toMatchObject({ work_order_id: WO, actor_id: "u1", event_type: "edit", shop_visible: false });
    expect(event.row?.message).toBe("Request type changed by CDS: Service / Cleaning to Parts Only");
  });

  it("switches back to service", async () => {
    wo = { status: "picked_up", request_type: "parts_only" };
    await updateWorkOrderRequestType(WO, {}, form("service"));
    expect(updates()[0].row).toEqual({ request_type: "service" });
    expect(events()[0].row?.message).toBe("Request type changed by CDS: Parts Only to Service / Cleaning");
  });

  it("does nothing when the type is unchanged", async () => {
    const res = await updateWorkOrderRequestType(WO, {}, form("service"));
    expect(res.ok).toBeTruthy();
    expect(updates()).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });

  it("refuses a completed, invoiced or cancelled order, and an order in review", async () => {
    for (const status of ["completed", "delivered", "ready_to_invoice", "invoiced", "cancelled", "pending_review"]) {
      wo = { status, request_type: "service" };
      expect((await updateWorkOrderRequestType(WO, {}, form("parts_only"))).error, status).toBeTruthy();
    }
    expect(updates()).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });

  it("refuses an unknown request type and a missing order", async () => {
    expect((await updateWorkOrderRequestType(WO, {}, form("other"))).error).toMatch(/request type/i);
    wo = null;
    expect((await updateWorkOrderRequestType(WO, {}, form("parts_only"))).error).toMatch(/not found/);
    expect((await updateWorkOrderRequestType("nope", {}, form("parts_only"))).error).toMatch(/not found/);
    expect(updates()).toHaveLength(0);
  });

  it("shows the database's refusal and logs nothing", async () => {
    updateError = { message: "permission denied" };
    const res = await updateWorkOrderRequestType(WO, {}, form("parts_only"));
    expect(res.error).toMatch(/permission denied/);
    expect(events()).toHaveLength(0);
  });
});

describe("work order page", () => {
  const page = readFileSync(join(__dirname, "../../src/app/cds/work-orders/[id]/page.tsx"), "utf8");
  it("has a request-type-only form on the Request Type fact, wired to updateWorkOrderRequestType", () => {
    expect(page).toMatch(/canEditRequestTypeOnly\(wo\.status\)/);
    expect(page).toMatch(/updateWorkOrderRequestType\.bind\(null, wo\.id\)/);
    expect(page).toMatch(/name="request_type"/);
  });
});
