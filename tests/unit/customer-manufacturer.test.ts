/**
 * The customer's stated manufacturer on the order (Sarah, CDS, 2026-11-23: "can we have the
 * manufacturer that is listed in the original request from the customer be listed on the WO
 * that the affiliate sees on their end?"). Same pattern as the customer Part #
 * (tests/unit/customer-part-number.test.ts):
 *
 *  - work_orders.customer_manufacturer (nullable, shop-readable like unit, PO and Part #).
 *  - Email intake fills it from the Manufacturer field of the Ryder form (the only request
 *    template with one: the website form and the iProcure PO have no such field). The CDS-only
 *    internal note keeps its "Manufacturer: X." line.
 *  - CDS enters it on Create Work Order and in Edit order, and edits it alone after dispatch
 *    like the PO and Part #.
 *  - The shop sees it as "Manufacturer (customer)" on the job page, the job list card and its
 *    emails.
 * The database side is in tests/rls/customer-manufacturer.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDraftParams } from "@/lib/intake/draft";
import type { LlmExtractor } from "@/lib/intake/llm";
import { parseEmail } from "@/lib/intake/parse";
import type { ParsedEmail } from "@/lib/intake/types";
import { buildShopEmail, type ShopEmailDetails } from "@/lib/shop-email";
import { reference } from "../fixtures/intake/reference";
import * as t from "../fixtures/intake/templates";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";
const EMAIL_ID = "00000000-0000-4000-8000-0000000e0461";
const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

type Call = { table: string; op: string; filters: [string, unknown][]; row?: Record<string, unknown> };
const calls: Call[] = [];
let wo: { status: string; customer_manufacturer: string | null } | null;

function query(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  calls.push(call);
  const result = () => {
    if (call.op === "update") return { data: [{ id: WO }], error: null };
    if (table === "work_orders") return { data: wo, error: null };
    return { data: null, error: null };
  };
  const q = {
    select: () => q,
    update: (row: Record<string, unknown>) => ((call.op = "update"), (call.row = row), q),
    insert: async (row: Record<string, unknown>) => ((call.op = "insert"), (call.row = row), { error: null }),
    eq: (col: string, v: unknown) => (call.filters.push([col, v]), q),
    maybeSingle: async () => result(),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}
const supabase = { from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { updateWorkOrderManufacturer } = await import("@/app/cds/work-orders/[id]/actions");

const parse = (email: Parameters<typeof parseEmail>[0]) => parseEmail(email, reference(), { llm: vi.fn<LlmExtractor>() });
const draft = (email: Parameters<typeof buildDraftParams>[1], parsed: ParsedEmail) => {
  const d = buildDraftParams(EMAIL_ID, email, parsed);
  if (!d.ok) throw new Error(d.reason);
  return d.params;
};

describe("email intake", () => {
  it("puts the Ryder form's Manufacturer on the order and keeps the CDS-only note line", async () => {
    const p = await parse(t.ryderDocKit);
    const params = draft(t.ryderDocKit, p);
    expect(params.p_customer_manufacturer).toBe("Cummins");
    expect(params.p_internal_notes).toContain("Manufacturer: Cummins.");
  });

  it("reads it from the Ryder text layout too", async () => {
    const p = await parse(t.ryderTextRows);
    expect(draft(t.ryderTextRows, p).p_customer_manufacturer).toBe("Detroit");
  });

  it("leaves it empty when the form's Manufacturer is blank", async () => {
    const p = await parse(t.ryderMissing);
    expect(draft(t.ryderMissing, p).p_customer_manufacturer).toBeNull();
  });

  it("leaves it empty for the website form, which has no manufacturer field", async () => {
    const p = await parse(t.webFormPepsi);
    expect(draft(t.webFormPepsi, p).p_customer_manufacturer).toBeNull();
  });

  it("is cut to 100 characters", async () => {
    const p = await parse(t.ryderDocKit);
    const parsed: ParsedEmail = { ...p, fields: { ...p.fields, manufacturer: { value: "M".repeat(150), source: "template", confidence: 1 } } };
    expect(draft(t.ryderDocKit, parsed).p_customer_manufacturer).toHaveLength(100);
  });
});

describe("the shop's emails", () => {
  const details: ShopEmailDetails = {
    workOrderId: WO,
    woNumber: 102155,
    shopName: "Example Diesel Shop",
    location: "Fleet Yard 1234",
    unitNumber: "U-77",
    poNumber: "PO-5521",
    partNumber: "A0009999",
    manufacturer: "Cummins",
    fulfillment: "pickup",
    lines: [{ item: "DPF cleaning", qty: 1 }],
    note: null,
    extraWork: null,
    since: null,
  };

  it("show the customer's manufacturer after the Part # on the new job email", () => {
    const e = buildShopEmail("dispatch", details, "https://portal.example.com");
    expect(e.text).toMatch(/Part #: A0009999\nManufacturer \(customer\): Cummins\n/);
    expect(e.html).toContain('<td style="color:#555">Manufacturer (customer)</td><td>Cummins</td>');
  });

  it("leave the row out when there is none", () => {
    const e = buildShopEmail("dispatch", { ...details, manufacturer: null }, "https://portal.example.com");
    expect(e.text).not.toContain("Manufacturer");
  });

  it("read it from the order", () => {
    expect(src("lib/shop-email-store.ts")).toMatch(/customer_manufacturer/);
    expect(src("lib/shop-email-run.ts")).toMatch(/manufacturer: ctx\.order\.manufacturer \?\? null/);
  });
});

describe("updateWorkOrderManufacturer (CDS, after dispatch, like the PO)", () => {
  const form = (v: string) => {
    const fd = new FormData();
    fd.set("customer_manufacturer", v);
    return fd;
  };
  const updates = () => calls.filter((c) => c.table === "work_orders" && c.op === "update");

  beforeEach(() => {
    calls.length = 0;
    wo = { status: "in_process", customer_manufacturer: null };
  });

  it("saves only the manufacturer and logs a CDS-only event", async () => {
    const res = await updateWorkOrderManufacturer(WO, {}, form("  Cummins "));
    expect(res).toMatchObject({ ok: "Manufacturer saved." });
    expect(updates()[0].row).toEqual({ customer_manufacturer: "Cummins" });
    const event = calls.find((c) => c.table === "work_order_events" && c.op === "insert");
    expect(event?.row).toMatchObject({ work_order_id: WO, event_type: "edit", shop_visible: false });
    expect(String(event?.row?.message)).toMatch(/Manufacturer \(customer\) changed by CDS: none to Cummins/);
  });

  it("clears it when the field is empty", async () => {
    wo!.customer_manufacturer = "Detroit";
    await updateWorkOrderManufacturer(WO, {}, form(""));
    expect(updates()[0].row).toEqual({ customer_manufacturer: null });
  });

  it("refuses a cancelled order and more than 100 characters", async () => {
    wo!.status = "cancelled";
    expect((await updateWorkOrderManufacturer(WO, {}, form("X"))).error).toBeTruthy();
    wo!.status = "in_process";
    expect((await updateWorkOrderManufacturer(WO, {}, form("x".repeat(101)))).error).toMatch(/100/);
    expect(updates()).toHaveLength(0);
  });
});

describe("screens", () => {
  it("CDS: Create Work Order has the field and passes it to cds_create_work_order", () => {
    expect(src("components/cds-wo/NewWorkOrderForm.tsx")).toMatch(/name="customer_manufacturer"/);
    expect(src("app/cds/work-orders/new/actions.ts")).toMatch(/p_customer_manufacturer:/);
  });

  it("CDS: the order shows it, with an edit after dispatch and in the Edit order box", () => {
    const page = src("app/cds/work-orders/[id]/page.tsx");
    expect(page).toMatch(/updateWorkOrderManufacturer\.bind\(null, wo\.id\)/);
    expect(page).toMatch(/id="edit-customer-manufacturer"[^>]*name="customer_manufacturer"/);
    expect(page).toMatch(/customer_manufacturer: string \| null/);
    expect(src("app/cds/work-orders/[id]/actions.ts")).toMatch(/customer_manufacturer: manufacturer \|\| null/);
  });

  it("shop: the job page, the job list card and the CDS preview show it", () => {
    expect(src("app/shop/data.ts").match(/customer_manufacturer/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src("components/shop/JobDetail.tsx")).toMatch(/Manufacturer \(customer\) \{job\.customer_manufacturer\}/);
    expect(src("components/shop/JobQueue.tsx")).toMatch(/Manufacturer \(customer\) \{j\.customer_manufacturer\}/);
    expect(src("app/cds/affiliate-view/ShopPreview.tsx")).toMatch(/Manufacturer \(customer\) \{job\.customer_manufacturer\}/);
  });
});
