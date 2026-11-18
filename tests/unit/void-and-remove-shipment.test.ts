/**
 * Sarah, CDS, 2026-11-18: "Ability to delete shipment information (for when we make mistakes
 * on a label)".
 *
 *  - A leg with a label in use gets "Void label and remove": one confirm, the label is voided
 *    through the usual void path (ShipStation, then cds_void_shipment_label), then the leg is
 *    removed. When the void fails (a pickup booked, the carrier refuses) nothing is removed.
 *  - A leg with no label in use is removed directly, also with a tracking number typed by hand
 *    (20261119100000_remove_shipment_hand_tracking.sql; tests/rls/remove-shipment.test.ts).
 *  - An invoiced order offers neither.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shipmentRemoval, voidAndRemoveConfirm } from "@/components/cds-wo/remove-shipment";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

type LabelResult = { ok: true; message: string } | { ok: false; error: string };
const voidLabel = vi.fn(async (): Promise<LabelResult> => ({ ok: true, message: "Label voided." }));
vi.mock("@/lib/shipstation/labels", () => ({ voidLabel }));

const WO = "11111111-1111-4111-8111-111111111111";
const SHIP = "22222222-2222-4222-8222-222222222222";
const LABEL = "33333333-3333-4333-8333-333333333333";

let order: { status: string; work_order_internal: { qb_invoice_id: string | null } | null } | null;
let activeLabel: { id: string } | null;
let removeAnswer: { data: null; error: { code?: string; message: string } | null };
const calls: string[] = [];
const labelFilters: [string, unknown][] = [];

/** A query that answers .maybeSingle() with the row of its table. */
function query(table: string) {
  const q = {
    select: () => q,
    eq: (col: string, value: unknown) => {
      if (table === "shipment_labels") labelFilters.push([col, value]);
      return q;
    },
    maybeSingle: async () => ({ data: table === "work_orders" ? order : activeLabel, error: null }),
  };
  return q;
}
const supabase = {
  from: vi.fn((table: string) => query(table)),
  rpc: vi.fn(async (name: string) => {
    calls.push(name);
    return removeAnswer;
  }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { voidLabelAndRemoveShipment } = await import("@/app/cds/work-orders/[id]/actions");

beforeEach(() => {
  order = { status: "accepted", work_order_internal: { qb_invoice_id: null } };
  activeLabel = { id: LABEL };
  removeAnswer = { data: null, error: null };
  calls.length = 0;
  labelFilters.length = 0;
  voidLabel.mockClear();
  voidLabel.mockImplementation(async () => {
    calls.push("voidLabel");
    return { ok: true, message: "Label voided." };
  });
});

describe("shipmentRemoval", () => {
  it("offers Remove on a leg without a label in use, also with a tracking number typed by hand", () => {
    expect(shipmentRemoval({ activeLabel: false, invoiced: false })).toBe("remove");
  });

  it("offers Void label and remove on a leg with a label in use", () => {
    expect(shipmentRemoval({ activeLabel: true, invoiced: false })).toBe("void_and_remove");
  });

  it("offers nothing on an invoiced order", () => {
    expect(shipmentRemoval({ activeLabel: false, invoiced: true })).toBeNull();
    expect(shipmentRemoval({ activeLabel: true, invoiced: true })).toBeNull();
  });
});

describe("voidAndRemoveConfirm", () => {
  it("says what voiding means and that the leg is removed", () => {
    const real = voidAndRemoveConfirm({ is_test: false, carrier: "FedEx", tracking_number: "7700" });
    expect(real).toMatch(/^Void the FedEx 7700 label in ShipStation\?/);
    expect(real).toMatch(/Then this shipment is removed from the work order, with its notes and costs\.$/);
    expect(voidAndRemoveConfirm({ is_test: true, carrier: "UPS", tracking_number: null })).toBe(
      "Void this test label? Then this shipment is removed from the work order, with its notes and costs.",
    );
  });
});

describe("voidLabelAndRemoveShipment", () => {
  it("voids the leg's label in use first, then removes the leg through cds_remove_shipment", async () => {
    const res = await voidLabelAndRemoveShipment(WO, SHIP);
    expect(res).toMatchObject({ ok: "Label voided and shipment removed." });
    expect(voidLabel).toHaveBeenCalledWith(supabase, LABEL);
    expect(calls).toEqual(["voidLabel", "cds_remove_shipment"]);
    expect(supabase.rpc).toHaveBeenCalledWith("cds_remove_shipment", { p_work_order: WO, p_shipment: SHIP });
    // The label is the active one of this leg on this order.
    expect(labelFilters).toEqual(
      expect.arrayContaining([
        ["shipment_id", SHIP],
        ["work_order_id", WO],
        ["status", "active"],
      ]),
    );
  });

  it("removes nothing when the void fails, and shows why", async () => {
    voidLabel.mockImplementation(async () => {
      calls.push("voidLabel");
      return { ok: false, error: "This label has a carrier pickup booked. Cancel the pickup before voiding the label." };
    });
    const res = await voidLabelAndRemoveShipment(WO, SHIP);
    expect(res).toEqual({
      error: "This label has a carrier pickup booked. Cancel the pickup before voiding the label. The shipment was not removed.",
    });
    expect(calls).toEqual(["voidLabel"]);
  });

  it("does not void anything on an invoiced order", async () => {
    order = { status: "in_process", work_order_internal: { qb_invoice_id: "QB1" } };
    expect(await voidLabelAndRemoveShipment(WO, SHIP)).toEqual({ error: "Shipments cannot be removed after the order is invoiced." });
    expect(calls).toEqual([]);
  });

  it("just removes the leg when its label was voided meanwhile", async () => {
    activeLabel = null;
    expect(await voidLabelAndRemoveShipment(WO, SHIP)).toMatchObject({ ok: "Shipment removed." });
    expect(calls).toEqual(["cds_remove_shipment"]);
  });

  it("says the label was voided when the removal is refused afterwards", async () => {
    removeAnswer = { data: null, error: { code: "P0001", message: "Shipments cannot be removed after the order is invoiced." } };
    expect(await voidLabelAndRemoveShipment(WO, SHIP)).toEqual({
      error: "The label was voided, but the shipment was not removed: Shipments cannot be removed after the order is invoiced.",
    });
  });

  it("refuses a bad id", async () => {
    expect(await voidLabelAndRemoveShipment(WO, "nope")).toEqual({ error: "Shipment not found." });
    expect(calls).toEqual([]);
  });
});

describe("work order page", () => {
  const page = readFileSync(new URL("../../src/app/cds/work-orders/[id]/page.tsx", import.meta.url), "utf8");

  it("decides the action with shipmentRemoval", () => {
    expect(page).toMatch(/shipmentRemoval\(\{ activeLabel: labels\.has\(s\.id\), invoiced: invoiceLockedNow \}\)/);
  });

  it("offers Void label and remove with one confirm, and Remove otherwise", () => {
    expect(page).toMatch(/voidLabelAndRemoveShipment\.bind\(null, wo\.id, s\.id\)/);
    expect(page).toMatch(/submitLabel="Void label and remove"/);
    expect(page).toMatch(/confirmText=\{voidAndRemoveConfirm\(/);
    expect(page).toMatch(/removeShipment\.bind\(null, wo\.id, s\.id\)/);
  });
});
