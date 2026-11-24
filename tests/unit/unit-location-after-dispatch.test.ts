/**
 * Unit # and customer location after dispatch (Sarah, CDS, 2026-11-24): once the order was sent
 * to the shop the Edit order box is gone, so a missing customer location ("The work order has
 * no customer location, so there is no ship-to address for sales tax.") or a wrong unit could
 * only be fixed by having the shop decline and dispatching again. CDS now changes each alone,
 * like the PO, Part # and manufacturer:
 *
 *  - At any status after dispatch except cancelled, until the customer invoice exists (Invoiced,
 *    or a QuickBooks invoice on the order): the unit and the location are on the invoice (memo,
 *    ship-to, sub-customer, tax), and the portal never changes QuickBooks.
 *  - The location must be one of the order's own customer's locations, in the order's market.
 *    It sets location_id, the label and the ship-to address as the Edit order picker does, the
 *    routing notes and the state's starting tax (a tax rate set by hand or an exempt customer
 *    stays). The shop, fulfillment, shipments and lines do not change. Existing labels keep the
 *    old address: CDS is told so.
 *  - The database's refusal (an invoice being created in QuickBooks) is shown as is.
 *  - CDS-only event; no shop email (the shop sees the change on its job page).
 * The database side is in tests/rls/unit-location-after-dispatch.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canEditUnitOrLocationOnly, LABELS_KEEP_OLD_ADDRESS_NOTE } from "@/components/cds-wo/util";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const NEW_LOC = "44444444-4444-4444-8444-444444444444";

type Call = { table: string; op: string; filters: [string, unknown][]; row?: Record<string, unknown> };
const calls: Call[] = [];
type Wo = {
  status: string;
  customer_id: string;
  location_id: string | null;
  location_label: string;
  market: string;
  unit_number: string | null;
  work_order_internal: { qb_invoice_id: string | null } | null;
};
let wo: Wo | null;
let loc: Record<string, unknown> | null;
let taxSource: string | null;
let rate: Record<string, unknown> | null;
let activeLabels: number;
let updateError: { message: string } | null;

function query(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  calls.push(call);
  const result = () => {
    if (call.op === "update") return { data: [{ id: WO }], error: table === "work_orders" ? updateError : null };
    if (table === "work_orders") return { data: wo, error: null };
    if (table === "customer_locations") {
      const id = call.filters.find(([c]) => c === "id")?.[1];
      const cust = call.filters.find(([c]) => c === "customer_id")?.[1];
      return { data: loc && id === loc.id && cust === loc.customer_id ? loc : null, error: null };
    }
    if (table === "work_order_internal") return { data: { tax_source: taxSource }, error: null };
    if (table === "tax_rates") return { data: rate, error: null };
    if (table === "shipment_labels") return { data: null, count: activeLabels, error: null };
    return { data: null, error: null };
  };
  const q = {
    select: () => q,
    update: (row: Record<string, unknown>) => ((call.op = "update"), (call.row = row), q),
    insert: async (row: Record<string, unknown>) => ((call.op = "insert"), (call.row = row), { error: null }),
    eq: (col: string, v: unknown) => (call.filters.push([col, v]), q),
    is: (col: string, v: unknown) => (call.filters.push([col, v]), q),
    maybeSingle: async () => result(),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}
const supabase = { from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { updateWorkOrderUnit, updateWorkOrderLocation } = await import("@/app/cds/work-orders/[id]/actions");

const form = (name: string, v: string) => {
  const fd = new FormData();
  fd.set(name, v);
  return fd;
};
const updatesOf = (table: string) => calls.filter((c) => c.table === table && c.op === "update");
const event = () => calls.find((c) => c.table === "work_order_events" && c.op === "insert");

beforeEach(() => {
  calls.length = 0;
  updateError = null;
  taxSource = "state_fallback";
  rate = { rate: 0.0725, taxes_parts: true, taxes_labor: false, taxes_shipping: true };
  activeLabels = 0;
  wo = {
    status: "in_process",
    customer_id: CUSTOMER,
    location_id: null,
    location_label: "Unknown location",
    market: "US",
    unit_number: "U-1",
    work_order_internal: { qb_invoice_id: null },
  };
  loc = {
    id: NEW_LOC,
    customer_id: CUSTOMER,
    code: "FY12",
    name: "Fleet Yard 12",
    address_raw: "100 Example Rd, Springfield, CA 90000",
    region: "CA",
    market: "US",
    routing_notes: "Dock 3",
  };
});

describe("canEditUnitOrLocationOnly", () => {
  it("after dispatch, at every status the shop works in and after the work is done", () => {
    for (const s of ["awaiting_acceptance", "accepted", "picked_up", "in_process", "completed", "delivered", "ready_to_invoice"]) {
      expect(canEditUnitOrLocationOnly(s, null), s).toBe(true);
    }
  });
  it("not in review (the Edit order box has them), not cancelled or invoiced", () => {
    for (const s of ["pending_review", "rejected_by_affiliate", "cancelled", "invoiced"]) {
      expect(canEditUnitOrLocationOnly(s, null), s).toBe(false);
    }
  });
  it("not once the order has its QuickBooks invoice (created while the shop still works)", () => {
    expect(canEditUnitOrLocationOnly("in_process", "QB-1")).toBe(false);
  });
});

describe("updateWorkOrderUnit", () => {
  it("saves only the unit on a dispatched order and logs a CDS-only event", async () => {
    const res = await updateWorkOrderUnit(WO, {}, form("unit_number", "  U-77 "));
    expect(res).toMatchObject({ ok: "Unit # saved." });
    const [u] = updatesOf("work_orders");
    expect(u.row).toEqual({ unit_number: "U-77" });
    expect(event()?.row).toMatchObject({ work_order_id: WO, event_type: "edit", shop_visible: false });
    expect(String(event()?.row?.message)).toBe("Unit # changed by CDS: U-1 to U-77");
  });

  it("requires a unit and refuses one over 100 characters", async () => {
    expect((await updateWorkOrderUnit(WO, {}, form("unit_number", "  "))).error).toMatch(/required/i);
    expect((await updateWorkOrderUnit(WO, {}, form("unit_number", "x".repeat(101)))).error).toMatch(/100/);
    expect(updatesOf("work_orders")).toHaveLength(0);
  });

  it("refuses in review, cancelled, invoiced and once the QuickBooks invoice exists", async () => {
    for (const status of ["pending_review", "cancelled", "invoiced"]) {
      wo!.status = status;
      expect((await updateWorkOrderUnit(WO, {}, form("unit_number", "U-2"))).error, status).toBeTruthy();
    }
    wo!.status = "in_process";
    wo!.work_order_internal = { qb_invoice_id: "QB-1" };
    expect((await updateWorkOrderUnit(WO, {}, form("unit_number", "U-2"))).error).toMatch(/QuickBooks/);
    expect(updatesOf("work_orders")).toHaveLength(0);
  });

  it("shows the database's refusal (an invoice being created locks the unit)", async () => {
    updateError = { message: "The invoice for this work order is being created in QuickBooks. Try again in a moment." };
    expect((await updateWorkOrderUnit(WO, {}, form("unit_number", "U-2"))).error).toMatch(/being created/);
    expect(event()).toBeUndefined();
  });
});

describe("updateWorkOrderLocation", () => {
  it("sets the location, label and ship-to address, routing notes and starting tax; nothing else on the order", async () => {
    const res = await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC));
    expect(res).toMatchObject({ ok: "Location saved." });
    const [u] = updatesOf("work_orders");
    expect(u.row).toEqual({
      location_id: NEW_LOC,
      location_label: "FY12 Fleet Yard 12",
      site_address: "100 Example Rd, Springfield, CA 90000",
    });
    const [i] = updatesOf("work_order_internal");
    expect(i.row).toEqual({
      routing_notes: "Dock 3",
      tax_rate: 0.0725,
      tax_parts: true,
      tax_labor: false,
      tax_shipping: true,
      tax_jurisdiction: "CA",
      tax_source: "state_fallback",
    });
    // Shop, fulfillment, shipments and lines are not touched.
    expect(calls.some((c) => c.op !== "select" && ["shipments", "shipment_labels", "work_order_lines"].includes(c.table))).toBe(false);
    expect(event()?.row).toMatchObject({ work_order_id: WO, event_type: "edit", shop_visible: false });
    expect(String(event()?.row?.message)).toBe("Customer location changed by CDS: Unknown location to FY12 Fleet Yard 12");
  });

  it("keeps a tax rate CDS set by hand and the no-tax of an exempt customer", async () => {
    for (const source of ["manual", "customer_exempt"]) {
      calls.length = 0;
      taxSource = source;
      await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC));
      expect(updatesOf("work_order_internal")[0].row, source).toEqual({ routing_notes: "Dock 3" });
    }
  });

  it("only a location of the order's own customer, in the order's market", async () => {
    loc!.customer_id = "55555555-5555-4555-8555-555555555555";
    expect((await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC))).error).toMatch(/customer/);
    loc!.customer_id = CUSTOMER;
    loc!.market = "CA";
    expect((await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC))).error).toMatch(/market/);
    expect((await updateWorkOrderLocation(WO, {}, form("location_id", "not-a-uuid"))).error).toMatch(/Choose a location/);
    expect(updatesOf("work_orders")).toHaveLength(0);
  });

  it("refuses in review, cancelled, invoiced and once the QuickBooks invoice exists", async () => {
    for (const status of ["rejected_by_affiliate", "cancelled", "invoiced"]) {
      wo!.status = status;
      expect((await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC))).error, status).toBeTruthy();
    }
    wo!.status = "completed";
    wo!.work_order_internal = { qb_invoice_id: "QB-1" };
    expect((await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC))).error).toMatch(/QuickBooks/);
    expect(updatesOf("work_orders")).toHaveLength(0);
  });

  it("says existing shipping labels keep the old address", async () => {
    activeLabels = 1;
    const res = await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC));
    expect(res.ok).toBe(`Location saved. ${LABELS_KEEP_OLD_ADDRESS_NOTE}`);
    expect(LABELS_KEEP_OLD_ADDRESS_NOTE).toBe("Shipping labels already made keep the old address.");
  });

  it("the same location again changes nothing", async () => {
    wo!.location_id = NEW_LOC;
    const res = await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC));
    expect(res.ok).toBe("Location unchanged.");
    expect(updatesOf("work_orders")).toHaveLength(0);
  });

  it("shows the database's refusal and logs nothing", async () => {
    updateError = { message: "The customer and location cannot change after the order is invoiced" };
    expect((await updateWorkOrderLocation(WO, {}, form("location_id", NEW_LOC))).error).toMatch(/cannot change/);
    expect(updatesOf("work_order_internal")).toHaveLength(0);
    expect(event()).toBeUndefined();
  });
});

describe("work order page", () => {
  const page = readFileSync(join(__dirname, "../../src/app/cds/work-orders/[id]/page.tsx"), "utf8");
  it("has the unit and location edits wired to their actions, with the label note", () => {
    expect(page).toMatch(/updateWorkOrderUnit\.bind\(null, wo\.id\)/);
    expect(page).toMatch(/updateWorkOrderLocation\.bind\(null, wo\.id\)/);
    expect(page).toMatch(/canEditUnitOrLocationOnly\(wo\.status, qbInvoiceId\)/);
    expect(page).toMatch(/LABELS_KEEP_OLD_ADDRESS_NOTE/);
  });
});
