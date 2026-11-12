/**
 * CDS-only internal status (Sarah, CDS dispatch, 2026-11-12): most of what CDS tracks happens
 * outside the portal (in email), so CDS sets it by hand on the work order page and sees it in
 * the work order list. It never changes the real status and the shop never sees it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

type Call = { table: string; op: string; row?: unknown; filters: [string, unknown][] };
const calls: Call[] = [];
let current: { internal_status: string | null } | null;
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

const { setInternalStatus } = await import("@/app/cds/work-orders/[id]/actions");
const { INTERNAL_STATUSES, INTERNAL_STATUS_LABEL, parseInternalStatus } = await import("@/lib/internal-status");

const WO = "11111111-1111-4111-8111-111111111111";
const form = (value: string) => {
  const f = new FormData();
  f.set("internal_status", value);
  return f;
};

beforeEach(() => {
  calls.length = 0;
  current = { internal_status: null };
  updateError = null;
});

describe("internal status values", () => {
  it("are exactly the six CDS asked for, with their labels, in order", () => {
    expect(INTERNAL_STATUSES).toEqual(["eta_sent", "condemned", "invoice_ready", "invoice_sent", "no_action_needed", "closed"]);
    expect(INTERNAL_STATUSES.map((s) => INTERNAL_STATUS_LABEL[s])).toEqual([
      "ETA Sent",
      "Condemned",
      "Invoice Ready",
      "Invoice Sent",
      "No Action Needed",
      "Closed",
    ]);
  });

  it("parses a known value, blank as cleared, and refuses anything else", () => {
    expect(parseInternalStatus("invoice_sent")).toEqual({ value: "invoice_sent" });
    expect(parseInternalStatus("")).toEqual({ value: null });
    expect(parseInternalStatus(null)).toEqual({ value: null });
    expect(parseInternalStatus("invoiced")).toMatchObject({ error: expect.any(String) });
  });
});

describe("setInternalStatus", () => {
  it("saves the value on the CDS-only order row and logs a CDS-only event", async () => {
    const res = await setInternalStatus(WO, {}, form("eta_sent"));
    expect(res).toMatchObject({ ok: expect.stringContaining("ETA Sent") });
    const update = calls.find((c) => c.op === "update");
    expect(update).toMatchObject({ table: "work_order_internal", row: { internal_status: "eta_sent" } });
    expect(update?.filters).toContainEqual(["work_order_id", WO]);
    expect(calls.some((c) => c.table === "work_orders" && c.op !== "select")).toBe(false);
    const event = calls.find((c) => c.table === "work_order_events" && c.op === "insert");
    expect(event?.row).toMatchObject({ work_order_id: WO, event_type: "internal_status", shop_visible: false });
    expect((event?.row as { message: string }).message).toMatch(/ETA Sent/);
  });

  it("clears it when blank", async () => {
    current = { internal_status: "closed" };
    const res = await setInternalStatus(WO, {}, form(""));
    expect(res).toMatchObject({ ok: expect.stringMatching(/cleared/i) });
    expect(calls.find((c) => c.op === "update")?.row).toEqual({ internal_status: null });
  });

  it("does nothing when the value is unchanged", async () => {
    current = { internal_status: "closed" };
    const res = await setInternalStatus(WO, {}, form("closed"));
    expect(res).toMatchObject({ ok: expect.any(String) });
    expect(calls.some((c) => c.op === "update" || c.op === "insert")).toBe(false);
  });

  it("refuses an unknown value or work order", async () => {
    expect(await setInternalStatus(WO, {}, form("shipped"))).toMatchObject({ error: expect.any(String) });
    expect(await setInternalStatus("nope", {}, form("closed"))).toMatchObject({ error: expect.any(String) });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });
});
