/**
 * PO edit after the shop accepted (Sarah, CDS, 2026-11-17): the full Edit order box is only
 * there while the order is in review, so a PO that came late could not be added. CDS now edits
 * just the PO at any status except cancelled. When the order already has a QuickBooks invoice,
 * the portal says to change the PO in QuickBooks too (it never changes QuickBooks itself).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canEditPoOnly, PO_IN_QUICKBOOKS_NOTE } from "@/components/cds-wo/util";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";

type Call = { table: string; op: string; filters: [string, unknown][]; row?: Record<string, unknown> };
const calls: Call[] = [];
let wo: { status: string; po_number: string | null; work_order_internal: { qb_invoice_id: string | null } | null } | null;
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

const { updateWorkOrderPo } = await import("@/app/cds/work-orders/[id]/actions");

const form = (po: string) => {
  const fd = new FormData();
  fd.set("po_number", po);
  return fd;
};
const updates = () => calls.filter((c) => c.table === "work_orders" && c.op === "update");

beforeEach(() => {
  calls.length = 0;
  updateError = null;
  wo = { status: "in_process", po_number: null, work_order_internal: { qb_invoice_id: null } };
});

describe("canEditPoOnly", () => {
  it("offers the PO-only edit after dispatch, also once completed or invoiced", () => {
    for (const s of ["awaiting_acceptance", "accepted", "picked_up", "in_process", "completed", "delivered", "ready_to_invoice", "invoiced"]) {
      expect(canEditPoOnly(s), s).toBe(true);
    }
  });
  it("not in review (the full Edit order box has the PO) and not once cancelled", () => {
    for (const s of ["pending_review", "rejected_by_affiliate", "cancelled"]) expect(canEditPoOnly(s), s).toBe(false);
  });
});

describe("updateWorkOrderPo", () => {
  it("saves only the PO on an order the shop is working on and logs a CDS-only event", async () => {
    const res = await updateWorkOrderPo(WO, {}, form("  PO-7781 "));
    expect(res).toMatchObject({ ok: "PO saved." });
    const [u] = updates();
    expect(u.row).toEqual({ po_number: "PO-7781" });
    const event = calls.find((c) => c.table === "work_order_events" && c.op === "insert");
    expect(event?.row).toMatchObject({ work_order_id: WO, event_type: "edit", shop_visible: false });
    expect(String(event?.row?.message)).toMatch(/PO-7781/);
  });

  it("clears the PO when the field is empty", async () => {
    wo!.po_number = "OLD";
    await updateWorkOrderPo(WO, {}, form(""));
    expect(updates()[0].row).toEqual({ po_number: null });
  });

  it("tells CDS to change the PO in QuickBooks too when the invoice is already there", async () => {
    wo = { status: "invoiced", po_number: "A", work_order_internal: { qb_invoice_id: "123" } };
    const res = await updateWorkOrderPo(WO, {}, form("B"));
    expect(res.ok).toContain(PO_IN_QUICKBOOKS_NOTE);
    expect(PO_IN_QUICKBOOKS_NOTE).toBe("This invoice is already in QuickBooks. Change the PO there too.");
  });

  it("refuses a cancelled order and a PO over 100 characters", async () => {
    wo!.status = "cancelled";
    expect((await updateWorkOrderPo(WO, {}, form("X"))).error).toBeTruthy();
    wo!.status = "in_process";
    expect((await updateWorkOrderPo(WO, {}, form("x".repeat(101)))).error).toMatch(/100/);
    expect(updates()).toHaveLength(0);
  });

  it("shows the database's refusal (a QuickBooks invoice being created locks the PO)", async () => {
    updateError = { message: "This invoice is already being created. Refresh in a moment." };
    const res = await updateWorkOrderPo(WO, {}, form("B"));
    expect(res.error).toMatch(/being created/);
  });
});

describe("work order page", () => {
  const page = readFileSync(join(__dirname, "../../src/app/cds/work-orders/[id]/page.tsx"), "utf8");
  it("has a PO-only edit form wired to updateWorkOrderPo, with the QuickBooks note", () => {
    expect(page).toMatch(/updateWorkOrderPo\.bind\(null, wo\.id\)/);
    expect(page).toMatch(/canEditPoOnly\(wo\.status\)/);
    expect(page).toMatch(/PO_IN_QUICKBOOKS_NOTE/);
  });
});
