/**
 * Sarah, CDS, 2026-11-18: "Can we have the 'new from shop' orders bump to the top of the
 * summary page?" The dashboard table lists the orders marked New from shop (shop activity CDS
 * has not opened yet) first, then the rest; within each group the status order of the tracking
 * sheet holds (list_rank, newest first, id). The flag is a column of public.work_order_list
 * (new_from_shop, 20261119200000_new_from_shop_first.sql) so the database sorts it before the
 * table's 200-row limit. The CSV export keeps the sheet order. The database test is in
 * tests/rls/work-order-list-order.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { filteredWorkOrders, parseFilters } = await import("@/components/cds-wo/woFilters");

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function fakeSupabase() {
  const calls: [string, ...unknown[]][] = [];
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
  return { supabase: { from: () => list }, calls };
}

const orders = async (opts?: { newFromShopFirst?: boolean }) => {
  const { supabase, calls } = fakeSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await filteredWorkOrders(supabase as any, parseFilters({}), "id", opts);
  return calls.filter(([n]) => n === "order");
};

describe("work order table order", () => {
  it("dashboard: New from shop first, then the sheet order", async () => {
    expect(await orders({ newFromShopFirst: true })).toEqual([
      ["order", "new_from_shop", { ascending: false }],
      ["order", "list_rank", { ascending: true }],
      ["order", "created_at", { ascending: false }],
      ["order", "id"],
    ]);
  });

  it("CSV export (no option): the sheet order unchanged", async () => {
    expect(await orders()).toEqual([
      ["order", "list_rank", { ascending: true }],
      ["order", "created_at", { ascending: false }],
      ["order", "id"],
    ]);
  });

  it("the dashboard asks for it, the export does not", () => {
    expect(read("src/app/cds/page.tsx")).toMatch(/filteredWorkOrders\(supabase, filters, LIST_COLUMNS, \{ newFromShopFirst: true \}\)/);
    expect(read("src/app/cds/export/route.ts")).toMatch(/filteredWorkOrders\(supabase, filters, columns\)/);
  });
});

describe("database: work_order_list.new_from_shop", () => {
  const dir = join(root, "supabase/migrations");
  const file = readdirSync(dir)
    .filter((f) => /create view public\.work_order_list/.test(readFileSync(join(dir, f), "utf8")))
    .sort()
    .at(-1)!;
  const sql = readFileSync(join(dir, file), "utf8");

  it("the latest view definition keeps new_from_shop from work_order_shop_activity.is_new", () => {
    // 20261119200000_new_from_shop_first.sql added it; 20261123100000 added shop_bill_pending_approval.
    expect(file).toBe("20261123100000_shop_bill_approval.sql");
    expect(sql).toMatch(/drop view public\.work_order_list;/);
    expect(sql).toMatch(/exists \(\s*select 1 from public\.work_order_shop_activity a\s*where a\.work_order_id = w\.id and a\.is_new\s*\) as new_from_shop/);
  });

  it("keeps list_rank, tracking_search, security_invoker, CDS only and the grants", () => {
    const before = readFileSync(join(dir, "20261113010000_work_order_list_order.sql"), "utf8");
    const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
    expect(between(sql, "(case", "as list_rank")).toBe(between(before, "(case", "as list_rank"));
    expect(sql).toMatch(/as tracking_search/);
    expect(sql).toMatch(/with \(security_invoker = true\)/);
    expect(sql).toMatch(/where \(select private\.is_cds\(\)\);/);
    for (const g of [
      "revoke all on table public.work_order_list from public, anon, authenticated, service_role;",
      "grant maintain, select on table public.work_order_list to authenticated;",
      "grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_list to service_role;",
    ]) {
      expect(sql).toContain(g);
    }
  });
});
