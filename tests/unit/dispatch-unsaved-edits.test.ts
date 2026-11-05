/**
 * Sarah picked the location for WO 101592 in Edit order and clicked Approve & Dispatch
 * without Save Changes: the order was dispatched and the location was silently lost (no edit
 * in History, location still empty; reproduced on the test project, 2026-11-05). Approve &
 * Dispatch now saves pending Edit order changes first, and does not dispatch when that save
 * fails.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { formChanged, runWithPendingEdits } from "@/components/cds-wo/pending-edits";

const fd = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe("formChanged", () => {
  it("is false for the same fields and values", () => {
    expect(formChanged(fd([["location_id", ""], ["unit_number", "5549912"]]), fd([["location_id", ""], ["unit_number", "5549912"]]))).toBe(false);
  });
  it("is true when a picked location changed the hidden location_id", () => {
    expect(formChanged(fd([["location_id", ""]]), fd([["location_id", "29b1b000-0000-4000-8000-000000000001"]]))).toBe(true);
  });
});

describe("runWithPendingEdits", () => {
  it("saves the pending edits, then dispatches", async () => {
    const calls: string[] = [];
    const save = vi.fn(async () => (calls.push("save"), { ok: true, message: "Order details saved." }));
    const run = vi.fn(async () => (calls.push("dispatch"), { ok: true, message: "Dispatched." }));
    const r = await runWithPendingEdits({ pending: fd([["location_id", "x"]]), save, run });
    expect(calls).toEqual(["save", "dispatch"]);
    expect(r).toMatchObject({ ok: true });
  });

  it("does not dispatch when saving the edits fails", async () => {
    const save = vi.fn(async () => ({ error: "Location is required." }));
    const run = vi.fn(async () => ({ ok: true }));
    const r = await runWithPendingEdits({ pending: fd([["location_label", ""]]), save, run });
    expect(run).not.toHaveBeenCalled();
    expect(r.error).toContain("Location is required.");
  });

  it("only dispatches when nothing is pending", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const run = vi.fn(async () => ({ ok: true }));
    await runWithPendingEdits({ pending: null, save, run });
    expect(save).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("work order page", () => {
  it("wires Approve & Dispatch to save pending Edit order changes first", () => {
    const page = readFileSync("src/app/cds/work-orders/[id]/page.tsx", "utf8");
    const dispatchForm = page.slice(page.indexOf("dispatchWorkOrder.bind"), page.indexOf("dispatchWorkOrder.bind") + 400);
    expect(dispatchForm).toMatch(/saveFirst/);
  });
});
