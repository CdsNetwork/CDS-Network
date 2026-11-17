/**
 * "Request invoice correction" (Sarah, CDS, 2026-11-17): on a completed job the shop asks
 * CDS to correct the invoice with a short reason. It is saved as a shop note starting with
 * "Invoice correction requested: ", so it raises "New from shop" like any shop note
 * (private.shop_note_activity), and the CDS dashboard row shows "Correction requested" until
 * CDS opens the order.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  correctionNote,
  correctionRequested,
  canRequestCorrection,
  INVOICE_CORRECTION_PREFIX,
} from "@/lib/invoice-correction";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireShop: vi.fn(async () => ({ id: "s1", kind: "shop" })) }));
vi.mock("@/lib/portal-email-send", () => ({ emailCdsAfter: vi.fn() }));
vi.mock("@/lib/qbo/bill-server", () => ({ createShopBillAfter: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";
const inserts: { table: string; row: Record<string, unknown> }[] = [];
let status = "completed";
const supabase = {
  from: (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === "work_orders" ? { status } : null, error: null }),
      insert: async (row: Record<string, unknown>) => (inserts.push({ table, row }), { error: null }),
    };
    return q;
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { requestInvoiceCorrection } = await import("@/app/shop/actions");

const form = (reason: string) => {
  const fd = new FormData();
  fd.set("reason", reason);
  return fd;
};

beforeEach(() => {
  inserts.length = 0;
  status = "completed";
});

describe("correction note", () => {
  it("prefixes the reason", () => {
    expect(INVOICE_CORRECTION_PREFIX).toBe("Invoice correction requested: ");
    expect(correctionNote("  Wrong qty on gaskets ")).toEqual({ body: "Invoice correction requested: Wrong qty on gaskets" });
  });
  it("needs a reason of at most 500 characters", () => {
    expect(correctionNote("  ")).toHaveProperty("error");
    expect(correctionNote("x".repeat(501))).toHaveProperty("error");
  });
  it("is offered once the shop completed the job, not before and not on a cancelled job", () => {
    for (const s of ["completed", "delivered", "ready_to_invoice", "invoiced"]) expect(canRequestCorrection(s), s).toBe(true);
    for (const s of ["accepted", "picked_up", "in_process", "awaiting_acceptance", "cancelled"]) expect(canRequestCorrection(s), s).toBe(false);
  });
});

describe("correctionRequested (dashboard badge)", () => {
  const note = (created_at: string, body = `${INVOICE_CORRECTION_PREFIX}x`, author_kind: string | null = "shop") => ({ body, created_at, author_kind });
  it("shows for a shop correction note CDS has not seen", () => {
    expect(correctionRequested([note("2026-11-17T10:00:00Z")], null)).toBe(true);
    expect(correctionRequested([note("2026-11-17T10:00:00Z")], "2026-11-17T09:00:00Z")).toBe(true);
  });
  it("not once CDS opened the order after it, not for other notes, not for CDS's own notes", () => {
    expect(correctionRequested([note("2026-11-17T10:00:00Z")], "2026-11-17T11:00:00Z")).toBe(false);
    expect(correctionRequested([note("2026-11-17T10:00:00Z", "Parts shipped")], null)).toBe(false);
    expect(correctionRequested([note("2026-11-17T10:00:00Z", undefined, "cds")], null)).toBe(false);
    expect(correctionRequested(null, null)).toBe(false);
  });
});

describe("requestInvoiceCorrection", () => {
  it("adds the prefixed shop note", async () => {
    const res = await requestInvoiceCorrection(WO, {}, form("Wrong qty"));
    expect(res.error).toBeUndefined();
    expect(inserts).toEqual([{ table: "work_order_notes", row: { work_order_id: WO, body: "Invoice correction requested: Wrong qty" } }]);
  });
  it("refuses an empty reason and a job that is not completed", async () => {
    expect((await requestInvoiceCorrection(WO, {}, form(" "))).error).toBeTruthy();
    status = "in_process";
    expect((await requestInvoiceCorrection(WO, {}, form("Wrong qty"))).error).toBeTruthy();
    expect(inserts).toHaveLength(0);
  });
});

describe("screens", () => {
  const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
  it("the shop job page has the button on a completed job", () => {
    const d = src("components/shop/JobDetail.tsx");
    expect(d).toMatch(/Request invoice correction/);
    expect(d).toMatch(/requestInvoiceCorrection\.bind\(null, id\)/);
    expect(d).toMatch(/canRequestCorrection\(job\.status\)/);
  });
  it("the CDS dashboard row shows Correction requested", () => {
    const page = src("app/cds/page.tsx");
    expect(page).toMatch(/Correction requested/);
    expect(page).toMatch(/correctionRequested\(/);
  });
  it("New from shop still comes from the shop note trigger (no new flag)", () => {
    const sql = readFileSync(join(__dirname, "../../supabase/migrations/20261111040000_shop_updates.sql"), "utf8");
    expect(sql).toMatch(/create trigger shop_activity after insert on public\.work_order_notes/);
  });
});
