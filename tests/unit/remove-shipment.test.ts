/**
 * Staff created shipment legs by accident and could not delete them. A leg can be removed
 * only while it has no active label and no tracking number and the order is not invoiced. The
 * database checks this (public.cds_remove_shipment, 20261118040000_remove_shipment_rpc.sql;
 * tests/rls/remove-shipment.test.ts): the action calls it and never deletes the row itself,
 * since a plain DELETE through the Data API skipped these checks (review 2026-11-16).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const from = vi.fn();
let answer: { data: null; error: { code?: string; message: string } | null };
const rpc = vi.fn(async () => answer);
const supabase = { rpc, from };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { removeShipment } = await import("@/app/cds/work-orders/[id]/actions");

const WO = "11111111-1111-4111-8111-111111111111";
const SHIP = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  answer = { data: null, error: null };
  rpc.mockClear();
  from.mockClear();
});

describe("removeShipment", () => {
  it("removes the leg through cds_remove_shipment, never with a direct delete", async () => {
    const res = await removeShipment(WO, SHIP);
    expect(res).toMatchObject({ ok: "Shipment removed." });
    expect(rpc).toHaveBeenCalledWith("cds_remove_shipment", { p_work_order: WO, p_shipment: SHIP });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    "This shipment has a label. Void the label first, then remove the shipment.",
    "This shipment has a tracking number, so it cannot be removed.",
    "This shipment has a label or one is being made. Void the label first, then remove the shipment.",
    "Shipments cannot be removed after the order is invoiced.",
  ])("shows the database's refusal: %s", async (message) => {
    answer = { data: null, error: { code: "P0001", message } };
    expect(await removeShipment(WO, SHIP)).toEqual({ error: message });
  });

  it("refuses a leg that is not on this work order or a bad id", async () => {
    answer = { data: null, error: { code: "P0002", message: "Shipment not found." } };
    expect(await removeShipment(WO, SHIP)).toEqual({ error: "Shipment not found." });
    rpc.mockClear();
    expect(await removeShipment(WO, "nope")).toEqual({ error: "Shipment not found." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not show a technical error", async () => {
    answer = { data: null, error: { code: "42501", message: "permission denied for function cds_remove_shipment" } };
    expect(await removeShipment(WO, SHIP)).toEqual({ error: "The shipment could not be removed. Try again." });
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
