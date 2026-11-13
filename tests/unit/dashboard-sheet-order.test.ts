/**
 * Sarah (CDS dispatch), 2026-11-13: the CDS dashboard works more like the Google tracking sheet.
 *
 * 1. No "Needs Attention" section (and no stat tile for it): the table is the work queue.
 * 2. The work order table is sorted by status, most pressing first, newest first within a
 *    status. The order is a database column (work_order_list.list_rank,
 *    20261113010000_work_order_list_order.sql) so it holds across the CSV export's pages.
 * 3. The search box also finds an order by any of its shipments' tracking numbers, ignoring
 *    spaces and case.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { filteredWorkOrders, parseFilters } = await import("@/components/cds-wo/woFilters");

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** A query builder that records the table and every call made on the work order list. */
function fakeSupabase() {
  const calls: [string, ...unknown[]][] = [];
  const tables: string[] = [];
  const list = new Proxy(
    {},
    {
      get(_t, name: string) {
        return (...args: unknown[]) => {
          calls.push([name, ...args]);
          return list;
        };
      },
    },
  );
  const customers = {
    select: () => customers,
    ilike: () => customers,
    limit: async () => ({ data: [], error: null }),
  };
  const supabase = {
    from: (table: string) => {
      tables.push(table);
      return table === "customers" ? customers : list;
    },
  };
  return { supabase, calls, tables };
}

describe("Needs Attention is gone from the CDS dashboard", () => {
  const page = read("src/app/cds/page.tsx");

  it("has no attention section, card grid or stat tile", () => {
    expect(page).not.toMatch(/Needs Attention/);
    expect(page).not.toMatch(/#attention/);
    expect(page).not.toMatch(/id="attention"/);
    expect(page).not.toMatch(/attentionGrid|attentionCard/);
  });

  it("no longer queries declined orders, pending reviews or carrier exceptions for it", () => {
    expect(page).not.toMatch(/attentionQuery/);
    expect(page).not.toMatch(/SHIPMENT_PROBLEM_STATUSES/);
  });

  it("keeps the other stat tiles", () => {
    for (const k of ['k: "In Progress"', 'k: "Ready to Invoice"', "k: `Invoiced: ", 'k: "Pending Review"']) expect(page).toContain(k);
  });
});

describe("Work order table order", () => {
  it("lists from work_order_list, by list_rank, then newest first, then id", async () => {
    const { supabase, calls, tables } = fakeSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkOrders(supabase as any, parseFilters({}), "id, status");
    expect(tables[0]).toBe("work_order_list");
    const orders = calls.filter(([n]) => n === "order");
    expect(orders).toEqual([
      ["order", "list_rank", { ascending: true }],
      ["order", "created_at", { ascending: false }],
      ["order", "id"],
    ]);
  });

  it("keeps the status, shop and condemned filters", async () => {
    const { supabase, calls } = fakeSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkOrders(supabase as any, parseFilters({ status: "in_progress" }), "id");
    expect(calls).toContainEqual(["in", "status", ["awaiting_acceptance", "accepted", "picked_up", "in_process"]]);
    const c = fakeSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkOrders(c.supabase as any, parseFilters({ status: "condemned" }), "id");
    expect(c.calls).toContainEqual(["eq", "condemned_components.result", "condemned"]);
  });
});

describe("Search by tracking number", () => {
  const ors = async (q: string) => {
    const { supabase, calls } = fakeSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkOrders(supabase as any, parseFilters({ q }), "id");
    return String(calls.find(([n]) => n === "or")?.[1] ?? "");
  };

  it("matches the shipments' tracking numbers without spaces, in lower case", async () => {
    expect(await ors("1Z 999 AA1")).toContain(`tracking_search.ilike."*1z999aa1*"`);
    expect(await ors("7712")).toContain(`tracking_search.ilike."*7712*"`);
  });

  it("still matches PO, unit, location and WO number", async () => {
    const s = await ors("284177");
    expect(s).toContain(`po_number.ilike."*284177*"`);
    expect(s).toContain(`unit_number.ilike."*284177*"`);
    expect(s).toContain("wo_number.eq.284177");
  });

  it("says so in the search box", () => {
    expect(read("src/app/cds/page.tsx")).toMatch(/placeholder="Search WO, PO, unit, customer, location, tracking/);
  });
});

describe("work_order_list migration", () => {
  const migration = () => read("supabase/migrations/20261113010000_work_order_list_order.sql");

  it("is a security_invoker view for CDS only, granted like work_order_financials", () => {
    const sql = migration();
    expect(sql).toMatch(/create view public\.work_order_list with \(security_invoker = true\)/);
    expect(sql).toMatch(/where \(select private\.is_cds\(\)\)/);
    expect(sql).toMatch(/grant maintain, select on table public\.work_order_list to authenticated/);
  });

  it("ranks the statuses in Sarah's order", () => {
    const sql = migration();
    const rank = (re: RegExp) => Number(sql.match(re)?.[1]);
    const pending = rank(/'pending_review' then (\d+)/);
    const question = rank(/question_pending\s*\) then (\d+)/);
    const declined = rank(/'rejected_by_affiliate' then (\d+)/);
    const awaiting = rank(/'awaiting_acceptance' then (\d+)/);
    const accepted = rank(/'accepted' then (\d+)/);
    const picked = rank(/'picked_up' then (\d+)/);
    const inProcess = rank(/'in_process' then (\d+)/);
    const completed = rank(/'completed' then (\d+)/);
    const delivered = rank(/'delivered' then (\d+)/);
    const toInvoice = rank(/'ready_to_invoice' then (\d+)/);
    const condemned = rank(/'condemned'\s*\) then (\d+)/);
    const invoiced = rank(/'invoiced' then (\d+)/);
    const cancelled = rank(/'cancelled' then (\d+)/);
    const order = [pending, question, declined, awaiting, accepted, picked, inProcess, completed, delivered, toInvoice, condemned, invoiced, cancelled];
    expect(order.every((n) => Number.isFinite(n))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });
});
