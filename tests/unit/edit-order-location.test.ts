/**
 * A draft from email can have no customer location (the email matched two locations), and
 * the Edit order box had only free text, so labels and invoicing stayed blocked. CDS now picks
 * the customer and the location there; the order then gets what Create Work Order derives
 * from a location: routing notes and the state's starting tax (unless CDS set the tax by
 * hand). Label, ship-to address and fulfillment come from the form, which fills them from the
 * location the same way the Create Work Order form does.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orderLocationSuggestions } from "@/components/cds-wo/location-match";
import type { LocationOption } from "@/components/cds-wo/NewWorkOrderForm";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";
const CUST = "22222222-2222-4222-8222-222222222222";
const OTHER_CUST = "33333333-3333-4333-8333-333333333333";
const LOC = "44444444-4444-4444-8444-444444444444";
const OLD_LOC = "55555555-5555-4555-8555-555555555555";

type Call = { table: string; op: string; filters: [string, string, unknown][]; row?: Record<string, unknown> };
const calls: Call[] = [];
let wo: { status: string; customer_id: string; location_id: string | null };
let location: Record<string, unknown> | null;
let customer: { id: string } | null;
let lineCount: number;
let taxSource: string | null;
let taxRate: Record<string, unknown> | null;

function query(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  calls.push(call);
  const has = (col: string, v: unknown) => call.filters.some(([, c, x]) => c === col && x === v);
  const result = () => {
    if (call.op !== "select") return { data: [{ id: "x" }], error: null };
    if (table === "work_orders") return { data: wo, error: null };
    if (table === "customers") return { data: customer, error: null };
    if (table === "customer_locations") {
      const ok = location && has("id", location.id) && has("customer_id", location.customer_id);
      return { data: ok ? location : null, error: null };
    }
    if (table === "work_order_lines") return { count: lineCount, data: null, error: null };
    if (table === "work_order_internal") return { data: { tax_source: taxSource }, error: null };
    if (table === "tax_rates") return { data: taxRate, error: null };
    return { data: null, error: null };
  };
  const q = {
    select: () => q,
    update: (row: Record<string, unknown>) => ((call.op = "update"), (call.row = row), q),
    insert: async (row: Record<string, unknown>) => ((call.op = "insert"), (call.row = row), { error: null }),
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

const { updateWorkOrderFields } = await import("@/app/cds/work-orders/[id]/actions");

function form(over: Record<string, string> = {}) {
  const fd = new FormData();
  const base: Record<string, string> = {
    unit_number: "1558",
    po_number: "PO1",
    requested_work: "DPF clean",
    location_label: "12549M - Moultonborough",
    site_address: "1 Main St, Moultonborough, NH 03254",
    request_type: "service",
    fulfillment: "shipping",
    customer_id: CUST,
    location_id: LOC,
    ...over,
  };
  for (const [k, v] of Object.entries(base)) fd.set(k, v);
  return fd;
}
const updates = (table: string) => calls.filter((c) => c.table === table && c.op === "update");

beforeEach(() => {
  calls.length = 0;
  wo = { status: "pending_review", customer_id: CUST, location_id: null };
  location = { id: LOC, customer_id: CUST, code: "12549M", name: "Moultonborough", region: "NH", market: "US", routing_notes: "Dock 3" };
  customer = { id: CUST };
  lineCount = 2;
  taxSource = null;
  taxRate = { rate: 0.0625, taxes_parts: true, taxes_labor: false, taxes_shipping: true };
});

describe("updateWorkOrderFields with a customer location", () => {
  it("sets the location on an order that had none, with its routing notes and starting tax, and logs it", async () => {
    const res = await updateWorkOrderFields(WO, {}, form());
    expect(res).toMatchObject({ ok: "Order details saved." });
    const [woUpdate] = updates("work_orders");
    expect(woUpdate.row).toMatchObject({ customer_id: CUST, location_id: LOC, location_label: "12549M - Moultonborough", fulfillment: "shipping" });
    const [internal] = updates("work_order_internal");
    expect(internal.row).toMatchObject({
      routing_notes: "Dock 3",
      tax_rate: 0.0625,
      tax_parts: true,
      tax_labor: false,
      tax_shipping: true,
      tax_jurisdiction: "NH",
      tax_source: "state_fallback",
    });
    const event = calls.find((c) => c.table === "work_order_events" && c.op === "insert");
    expect(event?.row).toMatchObject({ work_order_id: WO, event_type: "edit", shop_visible: false });
    expect(String(event?.row?.message)).toMatch(/12549M/);
  });

  it("keeps a tax rate CDS set by hand when the location changes", async () => {
    taxSource = "manual";
    wo.location_id = OLD_LOC;
    await updateWorkOrderFields(WO, {}, form());
    const [internal] = updates("work_order_internal");
    expect(internal.row).toEqual({ routing_notes: "Dock 3" });
  });

  it("leaves routing notes and tax alone when the location does not change", async () => {
    wo.location_id = LOC;
    expect(await updateWorkOrderFields(WO, {}, form())).toMatchObject({ ok: "Order details saved." });
    expect(updates("work_order_internal")).toHaveLength(0);
  });

  it("refuses a location that belongs to another customer", async () => {
    location = { ...location!, customer_id: OTHER_CUST };
    const res = await updateWorkOrderFields(WO, {}, form());
    expect((res as { error: string }).error).toMatch(/location/i);
    expect(updates("work_orders")).toHaveLength(0);
  });

  it("refuses to move an order with priced lines to another customer", async () => {
    customer = { id: OTHER_CUST };
    location = { ...location!, customer_id: OTHER_CUST };
    const res = await updateWorkOrderFields(WO, {}, form({ customer_id: OTHER_CUST }));
    expect((res as { error: string }).error).toMatch(/services or parts/i);
    expect(updates("work_orders")).toHaveLength(0);
  });

  it("moves an order without lines to another customer", async () => {
    lineCount = 0;
    customer = { id: OTHER_CUST };
    location = { ...location!, customer_id: OTHER_CUST };
    expect(await updateWorkOrderFields(WO, {}, form({ customer_id: OTHER_CUST }))).toMatchObject({ ok: "Order details saved." });
    expect(updates("work_orders")[0].row).toMatchObject({ customer_id: OTHER_CUST, location_id: LOC });
  });

  it("refuses an unknown customer or a bad location id", async () => {
    customer = null;
    expect((await updateWorkOrderFields(WO, {}, form({ customer_id: OTHER_CUST }))) as { error: string }).toMatchObject({
      error: expect.stringMatching(/customer/i),
    });
    customer = { id: CUST };
    expect((await updateWorkOrderFields(WO, {}, form({ location_id: "nope" }))) as { error: string }).toMatchObject({
      error: expect.stringMatching(/location/i),
    });
    expect(updates("work_orders")).toHaveLength(0);
  });

  it("refuses once the order is out of review", async () => {
    wo.status = "accepted";
    const res = await updateWorkOrderFields(WO, {}, form());
    expect((res as { error: string }).error).toMatch(/review/i);
    expect(updates("work_orders")).toHaveLength(0);
  });
});

const loc = (id: string, code: string): LocationOption => ({
  id,
  customer_id: CUST,
  code,
  location_number: null,
  name: `Name ${code}`,
  address_raw: "",
  city: null,
  region: null,
  postal_code: null,
  fulfillment: "shipping",
  routing_notes: null,
  dock_note: null,
  shopName: null,
});

describe("location suggestions", () => {
  const all = [loc("a", "100M"), loc("b", "200M"), loc("c", "300M"), loc("d", "400M")];

  it("lists the locations the email matched first, then the rest by number", () => {
    expect(orderLocationSuggestions(all, "", ["d", "b"]).map((l) => l.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("matches typed text as before when there are no email candidates", () => {
    expect(orderLocationSuggestions(all, "300", []).map((l) => l.id)).toEqual(["c"]);
  });
});

describe("work order page", () => {
  const page = readFileSync(new URL("../../src/app/cds/work-orders/[id]/page.tsx", import.meta.url), "utf8");
  const create = readFileSync(new URL("../../src/components/cds-wo/NewWorkOrderForm.tsx", import.meta.url), "utf8");

  it("offers the same customer and Location / Branch picker in Edit order as Create Work Order, with the email's candidates", () => {
    expect(page).toMatch(/<OrderLocationFields/);
    expect(page).toMatch(/candidateIds=\{/);
    expect(create).toMatch(/<LocationPicker/);
    const fields = readFileSync(new URL("../../src/components/cds-wo/OrderLocationFields.tsx", import.meta.url), "utf8");
    expect(fields).toMatch(/<LocationPicker/);
    expect(fields).toMatch(/name="customer_id"/);
  });
});
