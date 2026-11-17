/**
 * Linked work orders, light version (Sarah, CDS, 2026-11-17): one customer order split
 * across two shops is two work orders. CDS links one to the other by WO number on the work
 * order page; both pages then show "Linked to WO ####" (CDS only). Each keeps its own invoice.
 * The link lives in public.work_order_links (CDS only, no shop policy), so shops never see
 * it; the database rule is in tests/rls/linked-work-order.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkedOrders, parseWoNumber } from "@/components/cds-wo/linked-orders";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Call = { table: string; op: string; filters: [string, unknown][]; row?: Record<string, unknown> };
const calls: Call[] = [];
let orders: { id: string; wo_number: number }[];
let previous: string | null;

function query(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  calls.push(call);
  const result = () => {
    if (call.op === "upsert" || call.op === "delete") return { data: null, error: null };
    if (table === "work_orders") {
      const n = call.filters.find(([c]) => c === "wo_number")?.[1];
      const id = call.filters.find(([c]) => c === "id")?.[1];
      return { data: orders.find((o) => o.wo_number === n || o.id === id) ?? null, error: null };
    }
    if (table === "work_order_links") return { data: previous ? { linked_work_order_id: previous } : null, error: null };
    return { data: null, error: null };
  };
  const q = {
    select: () => q,
    upsert: (row: Record<string, unknown>) => ((call.op = "upsert"), (call.row = row), q),
    delete: () => ((call.op = "delete"), q),
    insert: async (row: Record<string, unknown> | Record<string, unknown>[]) => (
      (call.op = "insert"), (call.row = Array.isArray(row) ? { rows: row } : row), { error: null }
    ),
    eq: (col: string, v: unknown) => (call.filters.push([col, v]), q),
    maybeSingle: async () => result(),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}
const supabase = { from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { linkWorkOrder } = await import("@/app/cds/work-orders/[id]/actions");

const form = (v: string) => {
  const fd = new FormData();
  fd.set("linked_wo_number", v);
  return fd;
};
const writes = () => calls.filter((c) => c.table === "work_order_links" && (c.op === "upsert" || c.op === "delete"));

beforeEach(() => {
  calls.length = 0;
  previous = null;
  orders = [
    { id: WO, wo_number: 104100 },
    { id: OTHER, wo_number: 104101 },
  ];
});

describe("parseWoNumber", () => {
  it("reads 104101, WO 104101, WO-104101 and wo104101", () => {
    for (const v of ["104101", "WO 104101", "WO-104101", "wo104101", " WO - 104101 "]) expect(parseWoNumber(v), v).toBe(104101);
  });
  it("refuses text that is not a WO number", () => {
    for (const v of ["", "abc", "104101x", "1.5", "-3"]) expect(parseWoNumber(v), v).toBeNull();
  });
});

describe("linkedOrders", () => {
  it("lists the order this one links to and the orders that link to it, once each, by WO number", () => {
    const a = { id: "a", wo_number: 5 };
    const b = { id: "b", wo_number: 3 };
    expect(linkedOrders(a, [b, a])).toEqual([b, a]);
    expect(linkedOrders(null, [])).toEqual([]);
  });
});

describe("linkWorkOrder", () => {
  it("links the order to another one by WO number and logs CDS-only events on both", async () => {
    const res = await linkWorkOrder(WO, {}, form("WO-104101"));
    expect(res.ok).toMatch(/Linked to WO-104101/);
    const [u] = writes();
    expect(u).toMatchObject({ op: "upsert", row: { work_order_id: WO, linked_work_order_id: OTHER } });
    const events = calls.find((c) => c.table === "work_order_events" && c.op === "insert")?.row?.rows as Record<string, unknown>[];
    expect(events.map((e) => e.work_order_id).sort()).toEqual([WO, OTHER].sort());
    expect(events.every((e) => e.shop_visible === false)).toBe(true);
  });

  it("removes the link when the field is empty, with an event on the order it pointed to", async () => {
    previous = OTHER;
    const res = await linkWorkOrder(WO, {}, form(""));
    expect(res.ok).toBeTruthy();
    const [d] = writes();
    expect(d.op).toBe("delete");
    expect(d.filters).toContainEqual(["work_order_id", WO]);
    const events = calls.find((c) => c.table === "work_order_events" && c.op === "insert")?.row?.rows as Record<string, unknown>[];
    expect(events.map((e) => e.work_order_id).sort()).toEqual([WO, OTHER].sort());
  });

  it("refuses an unknown WO number, text that is not a number, and the order itself", async () => {
    expect((await linkWorkOrder(WO, {}, form("999999"))).error).toMatch(/No work order/);
    expect((await linkWorkOrder(WO, {}, form("abc"))).error).toMatch(/WO number/);
    expect((await linkWorkOrder(WO, {}, form("104100"))).error).toMatch(/itself/);
    expect(writes()).toHaveLength(0);
  });
});

describe("where the link is stored and shown", () => {
  const migrations = join(__dirname, "../../supabase/migrations");
  it("is a CDS-only table, not a column on work_orders (shops read their own work_orders rows)", () => {
    const sql = readFileSync(join(migrations, "20261119010000_linked_work_order.sql"), "utf8");
    expect(sql).toMatch(/create table public\.work_order_links/);
    expect(sql).toMatch(/create policy cds_all on public\.work_order_links/);
    expect(sql).not.toMatch(/create policy shop_read/);
    expect(sql).not.toMatch(/alter table public\.(work_orders|work_order_internal)\b/);
    expect(sql).toMatch(/grant .* on table public\.work_order_links to authenticated/);
  });
  it("the CDS work order page shows Linked to and a form to link; the shop screens never read it", () => {
    const page = readFileSync(join(__dirname, "../../src/app/cds/work-orders/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/Linked to/);
    expect(page).toMatch(/linkWorkOrder\.bind\(null, wo\.id\)/);
    for (const f of ["app/shop/data.ts", "components/shop/JobDetail.tsx", "app/cds/affiliate-view/ShopPreview.tsx"]) {
      expect(readFileSync(join(__dirname, "../../src", f), "utf8")).not.toMatch(/linked_work_order/);
    }
  });
});
