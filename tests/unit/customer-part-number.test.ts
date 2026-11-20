/**
 * The customer's part number on the order (Sarah, CDS, 2026-11-20: "If Ryder provides a part
 * number, can we have that show up when we dispatch the order to the affiliate?").
 *
 *  - work_orders.customer_part_number (nullable, shop-readable like unit and PO).
 *  - Email intake fills it from the Part # the email gives, for every customer; several part
 *    numbers are joined with ", ". The CDS-only internal note keeps its "Part #: X." line.
 *  - CDS enters it on Create Work Order and in Edit order, and edits it alone after dispatch
 *    like the PO.
 *  - The shop sees it as "Part #" on the job page, the job list card and its emails.
 * The database side is in tests/rls/customer-part-number.test.ts.
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
const EMAIL_ID = "00000000-0000-4000-8000-0000000e0460";
const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

type Call = { table: string; op: string; filters: [string, unknown][]; row?: Record<string, unknown> };
const calls: Call[] = [];
let wo: { status: string; customer_part_number: string | null } | null;

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

const { updateWorkOrderPartNumber } = await import("@/app/cds/work-orders/[id]/actions");

const parse = (email: Parameters<typeof parseEmail>[0]) => parseEmail(email, reference(), { llm: vi.fn<LlmExtractor>() });
const draft = (email: Parameters<typeof buildDraftParams>[1], parsed: ParsedEmail) => {
  const d = buildDraftParams(EMAIL_ID, email, parsed);
  if (!d.ok) throw new Error(d.reason);
  return d.params;
};

describe("email intake", () => {
  it("puts the Ryder Part # on the order and keeps the CDS-only note line", async () => {
    const p = await parse(t.ryderDpfClamps);
    const params = draft(t.ryderDpfClamps, p);
    expect(params.p_customer_part_number).toBe("A0009999");
    expect(params.p_internal_notes).toContain("Part #: A0009999.");
  });

  it("does it for every customer (website form)", async () => {
    const p = await parse(t.webFormPepsi);
    expect(draft(t.webFormPepsi, p).p_customer_part_number).toBe("A0009999");
  });

  it("leaves it empty when the email has no part number", async () => {
    const p = await parse(t.ryderMissing);
    expect(draft(t.ryderMissing, p).p_customer_part_number).toBeNull();
  });

  it("joins several part numbers read from a free-text email with a comma, once each", async () => {
    const p = await parse(t.ryderMissing);
    const item = (part_number: string | null, source: "llm" | "regex" | "template") => ({
      description: "Part",
      part_number,
      qty: 1,
      catalog_item_id: null,
      sku: null,
      name: null,
      via: "none" as const,
      source,
      confidence: 0.5,
    });
    const parsed: ParsedEmail = {
      ...p,
      fields: { ...p.fields, part_number: { value: "A111", source: "llm", confidence: 0.9 } },
      items: [item("B222", "llm"), item("a111", "regex"), item(null, "llm"), item("C333", "regex")],
    };
    expect(draft(t.ryderMissing, parsed).p_customer_part_number).toBe("A111, B222, C333");
  });

  it("does not take a template's line item numbers (an iProcure supplier item number is CDS's own)", async () => {
    const p = await parse(t.fsIprocureParts);
    expect(draft(t.fsIprocureParts, p).p_customer_part_number).toBeNull();
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
    fulfillment: "pickup",
    lines: [{ item: "DPF cleaning", qty: 1 }],
    note: null,
    extraWork: null,
    since: null,
  };

  it("show the Part # next to unit and PO on the new job email", () => {
    const e = buildShopEmail("dispatch", details, "https://portal.example.com");
    expect(e.text).toMatch(/Unit: U-77\nPO: PO-5521\nPart #: A0009999\n/);
    expect(e.html).toContain("<td style=\"color:#555\">Part #</td><td>A0009999</td>");
  });

  it("leave the row out when there is none", () => {
    const e = buildShopEmail("dispatch", { ...details, partNumber: null }, "https://portal.example.com");
    expect(e.text).not.toContain("Part #");
  });

  it("read it from the order", () => {
    expect(src("lib/shop-email-store.ts")).toMatch(/customer_part_number/);
  });
});

describe("updateWorkOrderPartNumber (CDS, after dispatch, like the PO)", () => {
  const form = (v: string) => {
    const fd = new FormData();
    fd.set("customer_part_number", v);
    return fd;
  };
  const updates = () => calls.filter((c) => c.table === "work_orders" && c.op === "update");

  beforeEach(() => {
    calls.length = 0;
    wo = { status: "in_process", customer_part_number: null };
  });

  it("saves only the part number and logs a CDS-only event", async () => {
    const res = await updateWorkOrderPartNumber(WO, {}, form("  A0009999 "));
    expect(res).toMatchObject({ ok: "Part # saved." });
    expect(updates()[0].row).toEqual({ customer_part_number: "A0009999" });
    const event = calls.find((c) => c.table === "work_order_events" && c.op === "insert");
    expect(event?.row).toMatchObject({ work_order_id: WO, event_type: "edit", shop_visible: false });
    expect(String(event?.row?.message)).toMatch(/Part # changed by CDS: none to A0009999/);
  });

  it("clears it when the field is empty", async () => {
    wo!.customer_part_number = "OLD";
    await updateWorkOrderPartNumber(WO, {}, form(""));
    expect(updates()[0].row).toEqual({ customer_part_number: null });
  });

  it("refuses a cancelled order and more than 200 characters", async () => {
    wo!.status = "cancelled";
    expect((await updateWorkOrderPartNumber(WO, {}, form("X"))).error).toBeTruthy();
    wo!.status = "in_process";
    expect((await updateWorkOrderPartNumber(WO, {}, form("x".repeat(201)))).error).toMatch(/200/);
    expect(updates()).toHaveLength(0);
  });
});

describe("search", () => {
  it("the shop's search also matches the part number", () => {
    expect(src("app/shop/data.ts")).toMatch(/`customer_part_number\.ilike\.\$\{like\}`/);
  });
});

describe("screens", () => {
  it("CDS: Create Work Order has the field and passes it to cds_create_work_order", () => {
    expect(src("components/cds-wo/NewWorkOrderForm.tsx")).toMatch(/name="customer_part_number"/);
    expect(src("app/cds/work-orders/new/actions.ts")).toMatch(/p_customer_part_number:/);
  });

  it("CDS: the order shows it, with an edit after dispatch and in the Edit order box", () => {
    const page = src("app/cds/work-orders/[id]/page.tsx");
    expect(page).toMatch(/updateWorkOrderPartNumber\.bind\(null, wo\.id\)/);
    expect(page).toMatch(/id="edit-part-number"[^>]*name="customer_part_number"/);
    expect(page).toMatch(/customer_part_number: string \| null/);
    const actions = src("app/cds/work-orders/[id]/actions.ts");
    expect(actions).toMatch(/customer_part_number: partNumber \|\| null/);
  });

  it("shop: the job page and the job list card show Part #", () => {
    expect(src("app/shop/data.ts").match(/customer_part_number/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src("components/shop/JobDetail.tsx")).toMatch(/Part # \{job\.customer_part_number\}/);
    expect(src("components/shop/JobQueue.tsx")).toMatch(/Part # \{j\.customer_part_number\}/);
    expect(src("app/cds/affiliate-view/ShopPreview.tsx")).toMatch(/customer_part_number/);
  });
});
