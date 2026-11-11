/**
 * Label status could only be changed on the Shipping page. The shipment box on the work
 * order page now has the same control, using the Shipping page's server action and its label
 * status rule (src/app/cds/shipping), so both pages accept exactly the same values.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));

type Update = { table: string; row: Record<string, unknown>; filters: [string, unknown][] };
const updates: Update[] = [];
let updated: { id: string; work_order_id: string }[];

function query(table: string) {
  const call: Update = { table, row: {}, filters: [] };
  const q = {
    update: (row: Record<string, unknown>) => ((call.row = row), updates.push(call), q),
    upsert: async () => ({ error: null }),
    eq: (col: string, v: unknown) => (call.filters.push([col, v]), q),
    select: () => q,
    then: (resolve: (v: unknown) => void) => resolve({ data: updated, error: null }),
  };
  return q;
}
const supabase = { from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { setShipmentLabelStatus, setShipmentStatus, updateShipment } = await import("@/app/cds/shipping/actions");
const { LABEL_STATUSES, SHIPMENT_STATUSES, isLabelStatus } = await import("@/app/cds/shipping/options");

const SHIP = "22222222-2222-4222-8222-222222222222";
const WO = "11111111-1111-4111-8111-111111111111";

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  updates.length = 0;
  updated = [{ id: SHIP, work_order_id: WO }];
  revalidatePath.mockClear();
});

describe("isLabelStatus", () => {
  it("accepts every Shipping page label status and nothing else", () => {
    for (const s of LABEL_STATUSES) expect(isLabelStatus(s.value)).toBe(true);
    expect(isLabelStatus("")).toBe(false);
    expect(isLabelStatus("lost")).toBe(false);
  });
});

describe("setShipmentLabelStatus", () => {
  it("saves the label status on the shipment and refreshes the Shipping and work order pages", async () => {
    const res = await setShipmentLabelStatus(SHIP, {}, form({ label_status: "printed" }));
    expect(res).toEqual({ ok: true, message: "Label status saved." });
    expect(updates).toEqual([{ table: "shipments", row: { label_status: "printed" }, filters: [["id", SHIP]] }]);
    expect(revalidatePath).toHaveBeenCalledWith("/cds/shipping");
    expect(revalidatePath).toHaveBeenCalledWith(`/cds/work-orders/${WO}`);
  });

  it("refuses a value the Shipping page does not offer", async () => {
    const res = await setShipmentLabelStatus(SHIP, {}, form({ label_status: "lost" }));
    expect(res).toEqual({ error: "Choose a label status." });
    expect(updates).toHaveLength(0);
  });

  it("refuses a bad or unknown shipment", async () => {
    expect(await setShipmentLabelStatus("nope", {}, form({ label_status: "ready" }))).toEqual({ error: "Shipment not found." });
    updated = [];
    expect(await setShipmentLabelStatus(SHIP, {}, form({ label_status: "ready" }))).toEqual({ error: "Shipment not found." });
  });

  it("uses the same rule as the Shipping page edit form", async () => {
    const res = await updateShipment(SHIP, {}, form({ direction: "customer_to_affiliate", label_status: "lost", status: "label_needed" }));
    expect(res).toEqual({ error: "Choose a label status." });
  });
});

describe("setShipmentStatus (Sarah 2026-11-11: change the status from the work order's shipment box)", () => {
  it("saves a Shipping page status and refreshes both pages", async () => {
    const res = await setShipmentStatus(SHIP, {}, form({ status: SHIPMENT_STATUSES[0] }));
    expect(res).toEqual({ ok: true, message: "Saved." });
    expect(updates).toEqual([{ table: "shipments", row: { status: SHIPMENT_STATUSES[0] }, filters: [["id", SHIP]] }]);
    expect(revalidatePath).toHaveBeenCalledWith("/cds/shipping");
    expect(revalidatePath).toHaveBeenCalledWith(`/cds/work-orders/${WO}`);
  });

  it("refuses a status the Shipping page does not offer, and a bad or unknown shipment", async () => {
    expect(await setShipmentStatus(SHIP, {}, form({ status: "lost" }))).toEqual({ error: "Choose a status." });
    expect(await setShipmentStatus("nope", {}, form({ status: SHIPMENT_STATUSES[0] }))).toEqual({ error: "Shipment not found." });
    expect(updates).toHaveLength(0);
    updated = [];
    expect(await setShipmentStatus(SHIP, {}, form({ status: SHIPMENT_STATUSES[0] }))).toEqual({ error: "Shipment not found." });
  });
});

describe("work order page shipment box", () => {
  it("offers the shipment status control bound to the Shipping page action and options", () => {
    const page = readFileSync(new URL("../../src/app/cds/work-orders/[id]/page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/setShipmentStatus\.bind\(null, s\.id\)/);
    expect(page).toMatch(/Object\.entries\(SHIPMENT_STATUS_LABEL\)\.map/);
    expect(page).toMatch(/name="status"/);
  });

  it("offers the label status control bound to the Shipping page action", () => {
    const page = readFileSync(new URL("../../src/app/cds/work-orders/[id]/page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/import \{ setShipmentLabelStatus, setShipmentStatus \} from "@\/app\/cds\/shipping\/actions"/);
    expect(page).toMatch(/setShipmentLabelStatus\.bind\(null, s\.id\)/);
    expect(page).toMatch(/LABEL_STATUSES\.map/);
    expect(page).toMatch(/name="label_status"/);
  });
});
