/**
 * Staff created shipment legs by accident and could not delete them. A leg can be removed
 * only while it has no active label and no tracking number; the server refuses otherwise.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

type Call = { table: string; op: string; filters: [string, string, unknown][]; row?: unknown };
const calls: Call[] = [];
let shipment: { tracking_number: string | null; carrier: string | null; label_status: string } | null;
let activeLabelCount: number;
let woStatus: string;

function query(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  calls.push(call);
  const result = () => {
    if (table === "shipment_labels") return { count: activeLabelCount, data: null, error: null };
    if (table === "work_orders") return { data: { status: woStatus }, error: null };
    if (table === "shipments" && call.op === "delete") return { data: shipment ? [{ id: "s" }] : [], error: null };
    if (table === "shipments") return { data: shipment, error: null };
    return { data: null, error: null };
  };
  const q = {
    select: () => q,
    delete: () => ((call.op = "delete"), q),
    insert: async (row: unknown) => ((call.op = "insert"), (call.row = row), { error: null }),
    eq: (col: string, v: unknown) => (call.filters.push(["eq", col, v]), q),
    is: (col: string, v: unknown) => (call.filters.push(["is", col, v]), q),
    in: (col: string, v: unknown) => (call.filters.push(["in", col, v]), q),
    maybeSingle: async () => result(),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}
const supabase = { from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { removeShipment } = await import("@/app/cds/work-orders/[id]/actions");

const WO = "11111111-1111-4111-8111-111111111111";
const SHIP = "22222222-2222-4222-8222-222222222222";
const deletes = () => calls.filter((c) => c.table === "shipments" && c.op === "delete");

beforeEach(() => {
  calls.length = 0;
  shipment = { tracking_number: null, carrier: "UPS", label_status: "needed" };
  activeLabelCount = 0;
  woStatus = "in_progress";
});

describe("removeShipment", () => {
  it("deletes a leg with no label and no tracking number, on this work order only, and logs it", async () => {
    const res = await removeShipment(WO, SHIP);
    expect(res).toMatchObject({ ok: "Shipment removed." });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].filters).toEqual(
      expect.arrayContaining([
        ["eq", "id", SHIP],
        ["eq", "work_order_id", WO],
        ["is", "tracking_number", null],
        ["in", "label_status", ["needed", "voided"]],
      ]),
    );
    const event = calls.find((c) => c.table === "work_order_events" && c.op === "insert");
    expect(event?.row).toMatchObject({ work_order_id: WO, event_type: "shipment", shop_visible: false });
  });

  it("refuses a leg that has an active label", async () => {
    activeLabelCount = 1;
    const res = await removeShipment(WO, SHIP);
    expect((res as { error: string }).error).toMatch(/label/i);
    expect(deletes()).toHaveLength(0);
  });

  it("refuses a leg that has a tracking number", async () => {
    shipment = { tracking_number: "1Z999", carrier: "UPS", label_status: "needed" };
    const res = await removeShipment(WO, SHIP);
    expect((res as { error: string }).error).toMatch(/tracking number/i);
    expect(deletes()).toHaveLength(0);
  });

  it("removes a leg whose label was voided", async () => {
    shipment = { tracking_number: null, carrier: "UPS", label_status: "voided" };
    expect(await removeShipment(WO, SHIP)).toMatchObject({ ok: "Shipment removed." });
  });

  it.each(["ready", "sent", "printed", "error"])("refuses a leg whose label is %s (made outside the portal or in progress)", async (labelStatus) => {
    shipment = { tracking_number: null, carrier: "UPS", label_status: labelStatus };
    const res = await removeShipment(WO, SHIP);
    expect((res as { error: string }).error).toMatch(/label/i);
    expect(deletes()).toHaveLength(0);
  });

  it("refuses once the order is invoiced", async () => {
    woStatus = "invoiced";
    const res = await removeShipment(WO, SHIP);
    expect((res as { error: string }).error).toMatch(/invoiced/i);
    expect(deletes()).toHaveLength(0);
  });

  it("refuses a leg that is not on this work order or a bad id", async () => {
    shipment = null;
    expect(await removeShipment(WO, SHIP)).toEqual({ error: "Shipment not found." });
    expect(await removeShipment(WO, "nope")).toEqual({ error: "Shipment not found." });
    expect(deletes()).toHaveLength(0);
  });
});

describe("work order page", () => {
  it("offers Remove on a leg only without a label or tracking number, after a confirm", () => {
    const page = readFileSync(new URL("../../src/app/cds/work-orders/[id]/page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/removeShipment\.bind\(null, wo\.id, s\.id\)/);
    expect(page).toMatch(/!labels\.has\(s\.id\) && !s\.tracking_number && REMOVABLE_LABEL_STATUSES\.includes\(s\.label_status\)/);
    expect(page).toMatch(/confirmText="Remove this shipment/);
  });
});
