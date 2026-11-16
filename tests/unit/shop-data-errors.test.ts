/**
 * The shop queue and job page read with the shop's own client. A read that fails must not
 * look like "no rows": an empty queue, a job with no deduction (the shop would see $230
 * instead of $215) or no lines. Required reads throw, so the page shows an error instead of
 * a wrong queue or a wrong settlement total. When every read succeeds nothing changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shopPayable } from "@/lib/shop-deductions";

vi.mock("server-only", () => ({}));

type Result = { data: unknown; error: { message: string } | null; count?: number | null };
let results: Record<string, Result>;

/** A chainable stand-in for a Supabase query on one table, resolving to results[table]. */
function query(table: string) {
  const res = () => results[table] ?? { data: [], error: null, count: 0 };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq", "or", "order", "range", "limit", "lte", "ilike"]) q[m] = () => q;
  q.maybeSingle = async () => {
    const r = res();
    return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
  };
  q.then = (ok: (v: Result) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(res()).then(ok, fail);
  return q;
}
const supabase = {
  from: vi.fn((table: string) => query(table)),
  storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { loadJob, loadQueue } = await import("@/app/shop/data");

const WO = "11111111-1111-4111-8111-111111111111";
const fail = (message: string): Result => ({ data: null, error: { message } });
const job = {
  id: WO, wo_number: 101951, status: "in_process", market: "west", fulfillment: "shipping",
  location_label: "Loc 424", site_address: null, unit_number: "284113", po_number: "PO1",
  requested_work: "DPF Cleaning", pickup_window: null, shop_ship_status: null, affiliate_invoice_ref: null,
  completed_at: null, customer_id: "c1", affiliate_id: "a1", request_type: "service", customers: { name: "Ryder" },
};
const line = { id: "l1", qty: 1, shop_unit_rate: 230, origin: "dispatch", description: null, created_at: "2026-11-16", catalog_items: { sku: "DPF", name: "DPF Cleaning" } };
const deduction = { work_order_id: WO, kind: "filter_shipping", filters: 1, unit_amount: "-15.00", amount: "-15.00" };
const readOnly = () => false;

beforeEach(() => {
  results = {
    work_orders: { data: [job], error: null, count: 1 },
    work_order_lines: { data: [line], error: null },
    work_order_shop_deductions: { data: [deduction], error: null },
    affiliates: { data: [{ is_in_house: false }], error: null },
  };
});

describe("shop job page reads", () => {
  it("loads the job, its line and its deduction when every read succeeds ($215)", async () => {
    const d = await loadJob(WO, readOnly);
    expect(d?.job.wo_number).toBe(101951);
    expect(d?.deductions).toEqual([{ kind: "filter_shipping", filters: 1, unit_amount: -15, amount: -15 }]);
    expect(shopPayable(d!.lines, d!.deductions)).toBe(215);
  });

  it("is null for a job the shop cannot see (no row, no error)", async () => {
    results.work_orders = { data: [], error: null };
    expect(await loadJob(WO, readOnly)).toBeNull();
  });

  it("throws when the deduction read fails, instead of a $230 total", async () => {
    results.work_order_shop_deductions = fail("deductions timeout");
    await expect(loadJob(WO, readOnly)).rejects.toThrow(/deductions timeout/);
  });

  it("throws when the lines read fails", async () => {
    results.work_order_lines = fail("lines timeout");
    await expect(loadJob(WO, readOnly)).rejects.toThrow(/lines timeout/);
  });

  it("throws when the work order read fails, instead of 'not available'", async () => {
    results.work_orders = fail("work order timeout");
    await expect(loadJob(WO, readOnly)).rejects.toThrow(/work order timeout/);
  });

  it.each(["work_order_components", "authorization_requests", "attachments", "shipments", "work_order_notes", "affiliates"])(
    "throws when the %s read fails",
    async (table) => {
      results[table] = fail(`${table} down`);
      await expect(loadJob(WO, readOnly)).rejects.toThrow(`${table} down`);
    },
  );
});

describe("shop queue reads", () => {
  it("returns the jobs when the reads succeed", async () => {
    const q = await loadQueue();
    expect(q.jobs.active.map((j) => j.wo_number)).toEqual([101951]);
  });

  it("throws when the queue read fails, instead of an empty queue", async () => {
    results.work_orders = fail("queue timeout");
    await expect(loadQueue()).rejects.toThrow(/queue timeout/);
  });

  it("throws when the customer search read fails", async () => {
    results.customers = fail("customers timeout");
    await expect(loadQueue("ryder")).rejects.toThrow(/customers timeout/);
  });
});
