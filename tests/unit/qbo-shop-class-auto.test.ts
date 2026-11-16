/**
 * CDS (Sarah, 2026-11-13): the QuickBooks Class of an invoice is always the same for a given
 * shop: the shop's "CDS <city>" class (a Houston shop gets "CDS Houston"); orders assigned to
 * Enviromotive get "CDS INC". When a shop has no qbo_affiliate_class row yet, creating the
 * invoice reads the active Classes from QuickBooks, picks the shop's class, uses it on this
 * invoice and remembers it (so later invoices skip the lookup and CDS can correct the row).
 * No match or a failed lookup never blocks the invoice: it goes out without a class, as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));

const createInvoice = vi.fn();
const getInvoice = vi.fn();
const listClasses = vi.fn();
vi.mock("@/lib/qbo/api", () => ({ createInvoice, getInvoice, listClasses, qboLookups: vi.fn(() => ({})) }));
vi.mock("@/lib/qbo/invoice-qbo", () => ({
  resolveInvoiceQbo: vi.fn(async (_l: unknown, p: unknown) => ({ payload: p, notes: [], subCustomer: null })),
  cachedSubCustomer: vi.fn(async () => null),
  saveSubCustomer: vi.fn(async () => {}),
}));
const qboApi = vi.fn(async () => ({ realmId: "1" }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi }));
const loadInvoice = vi.fn();
vi.mock("@/lib/qbo/invoice-input", () => ({ loadInvoice }));

/** Rows per table for reads; upserts are recorded. */
let tables: Record<string, Record<string, unknown>[]> = {};
const upserts: { table: string; row: unknown; options: unknown }[] = [];
/** Answers cds_mark_invoiced and other calls; the invoice claim (@/lib/qbo/invoice-claim) is always granted. */
const rpcAnswer = vi.fn();
const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === "cds_claim_qbo_invoice") {
    return { data: { state: "sending", claim_id: "c1", attempt: 0, request_id: String(args.p_work_order), snapshot: args.p_snapshot }, error: null };
  }
  if (name === "cds_finish_qbo_invoice") return { data: null, error: null };
  return rpcAnswer(name, args);
});
const supabase = {
  rpc,
  from: vi.fn((table: string) => {
    const eq: [string, unknown][] = [];
    const rows = () => (tables[table] ?? []).filter((r) => eq.every(([k, v]) => r[k] === v));
    const q: Record<string, unknown> = {
      insert: vi.fn(async () => ({ error: null })),
      upsert: vi.fn(async (row: unknown, options: unknown) => {
        upserts.push({ table, row, options });
        return { error: null };
      }),
      select: () => q,
      eq: (k: string, v: unknown) => {
        eq.push([k, v]);
        return q;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ count: 0, data: rows(), error: null }),
    };
    return q;
  }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { createQuickBooksInvoice } = await import("@/app/cds/work-orders/[id]/actions");
const { matchShopClass } = await import("@/lib/qbo/shop-class");

const WO = "11111111-1111-4111-8111-111111111111";
const SHOP = "a0000000-0000-4000-8000-000000000001";

const CLASSES = [
  { Id: "1", Name: "CDS Houston", Active: true },
  { Id: "2", Name: "CDS Dallas" },
  { Id: "3", Name: "CDS INC", Active: true },
  { Id: "4", Name: "CDS San Antonio", Active: true },
  { Id: "5", Name: "CDS Phoenix", Active: false },
  { Id: "6", Name: "Overhead", Active: true },
];

describe("matchShopClass", () => {
  it("matches the shop's city to its CDS <city> class", () => {
    expect(matchShopClass({ city: "Houston", displayName: "Gulf Coast Diesel", shortCode: "GCD" }, CLASSES)).toEqual({ id: "1", name: "CDS Houston" });
    // Case, spaces and punctuation do not matter.
    expect(matchShopClass({ city: "san antonio", displayName: "Alamo DPF", shortCode: "AL1" }, CLASSES)).toEqual({ id: "4", name: "CDS San Antonio" });
    expect(matchShopClass({ city: "SAN-ANTONIO ", displayName: "x", shortCode: null }, CLASSES)?.id).toBe("4");
  });

  it("matches the shop's name or code when the city does not match", () => {
    expect(matchShopClass({ city: "Irving", displayName: "Dallas", shortCode: "IRV" }, CLASSES)).toEqual({ id: "2", name: "CDS Dallas" });
    expect(matchShopClass({ city: null, displayName: "CDS Dallas", shortCode: "D9" }, CLASSES)).toEqual({ id: "2", name: "CDS Dallas" });
    expect(matchShopClass({ city: null, displayName: "Some shop", shortCode: "Houston" }, CLASSES)).toEqual({ id: "1", name: "CDS Houston" });
  });

  it("gives Enviromotive CDS INC, by name or code, whatever its city", () => {
    expect(matchShopClass({ city: "Houston", displayName: "Enviromotive", shortCode: "ENV" }, CLASSES)).toEqual({ id: "3", name: "CDS INC" });
    expect(matchShopClass({ city: "Houston", displayName: "In-house", shortCode: "ENVIROMOTIVE" }, CLASSES)).toEqual({ id: "3", name: "CDS INC" });
    // No CDS INC class: none, never the city's class.
    expect(matchShopClass({ city: "Houston", displayName: "Enviromotive", shortCode: "ENV" }, CLASSES.filter((c) => c.Id !== "3"))).toBeNull();
  });

  it("ignores inactive classes", () => {
    expect(matchShopClass({ city: "Phoenix", displayName: "Desert Diesel", shortCode: "PHX" }, CLASSES)).toBeNull();
    expect(
      matchShopClass({ city: "Houston", displayName: "Enviromotive", shortCode: "ENV" }, [{ Id: "3", Name: "CDS INC", Active: false }]),
    ).toBeNull();
  });

  it("gives none when nothing matches", () => {
    expect(matchShopClass({ city: "Boise", displayName: "Idaho Diesel", shortCode: "BOI" }, CLASSES)).toBeNull();
    expect(matchShopClass({ city: null, displayName: "", shortCode: null }, CLASSES)).toBeNull();
    // Only "CDS <something>" classes count.
    expect(matchShopClass({ city: "Overhead", displayName: "x", shortCode: null }, CLASSES)).toBeNull();
    expect(matchShopClass({ city: "Houston", displayName: "x", shortCode: null }, [])).toBeNull();
  });

  it("gives none when the shop points at more than one class, rather than guess", () => {
    // City says Houston, name says Dallas.
    expect(matchShopClass({ city: "Houston", displayName: "Dallas", shortCode: null }, CLASSES)).toBeNull();
    // Two active classes with the same name.
    const twice = [...CLASSES, { Id: "7", Name: "CDS  houston", Active: true }];
    expect(matchShopClass({ city: "Houston", displayName: "x", shortCode: null }, twice)).toBeNull();
    // City and name agreeing on one class is not ambiguous.
    expect(matchShopClass({ city: "Houston", displayName: "CDS Houston", shortCode: "HOU" }, CLASSES)?.id).toBe("1");
  });
});

const payload = { Line: [], CustomerRef: { value: "58", name: "Customer" } };
const invoiceState = (over: Record<string, unknown> = {}) => ({
  status: "ready_to_invoice",
  qbInvoiceId: null,
  qbInvoiceNumber: null,
  invoicedAt: null,
  pendingQb: null,
  affiliateId: SHOP,
  target: { locationId: null, siteNumber: null, locationName: null, city: null, poNumber: null, unitNumber: null },
  result: { ok: true, payload, warnings: [] },
  ...over,
});
const sentPayload = () => createInvoice.mock.calls[0][1] as Record<string, unknown>;
const classUpserts = () => upserts.filter((u) => u.table === "qbo_affiliate_class");

beforeEach(() => {
  createInvoice.mockReset();
  getInvoice.mockReset();
  listClasses.mockReset();
  rpc.mockClear();
  rpcAnswer.mockReset();
  loadInvoice.mockReset();
  qboApi.mockClear();
  upserts.length = 0;
  tables = { affiliates: [{ id: SHOP, display_name: "Gulf Coast Diesel", short_code: "GCD", city: "Houston" }] };
  createInvoice.mockResolvedValue({ Id: "145", DocNumber: "40126", TotalAmt: 100, TxnTaxDetail: { TotalTax: 0 } });
  rpcAnswer.mockResolvedValue({ error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createQuickBooksInvoice fills the shop's Class", () => {
  it("uses the existing qbo_affiliate_class row and does not look anything up", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ result: { ok: true, payload: { ...payload, ClassRef: { value: "99" } }, warnings: [] } }));
    listClasses.mockResolvedValue(CLASSES);

    const res = await createQuickBooksInvoice(WO);

    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 40126 created") });
    expect(listClasses).not.toHaveBeenCalled();
    expect(sentPayload().ClassRef).toEqual({ value: "99" });
    expect(classUpserts()).toEqual([]);
  });

  it("without a row: reads the Classes, sends the shop's class and remembers it", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    listClasses.mockResolvedValue(CLASSES);

    const res = await createQuickBooksInvoice(WO);

    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 40126 created") });
    expect(listClasses).toHaveBeenCalledTimes(1);
    expect(sentPayload().ClassRef).toEqual({ value: "1" });
    expect(classUpserts()).toEqual([
      {
        table: "qbo_affiliate_class",
        row: { affiliate_id: SHOP, qbo_class_id: "1", qbo_class_name: "CDS Houston", updated_by: "u1" },
        // A row CDS added meanwhile wins: insert only, never overwrite.
        options: { onConflict: "affiliate_id", ignoreDuplicates: true },
      },
    ]);
  });

  it("Enviromotive orders get CDS INC", async () => {
    tables.affiliates = [{ id: SHOP, display_name: "Enviromotive", short_code: "ENV", city: "Houston" }];
    loadInvoice.mockResolvedValue(invoiceState());
    listClasses.mockResolvedValue(CLASSES);
    await createQuickBooksInvoice(WO);
    expect(sentPayload().ClassRef).toEqual({ value: "3" });
    expect(classUpserts()[0].row).toMatchObject({ qbo_class_id: "3", qbo_class_name: "CDS INC" });
  });

  it("no matching class: the invoice goes out without a class and nothing is saved", async () => {
    tables.affiliates = [{ id: SHOP, display_name: "Idaho Diesel", short_code: "BOI", city: "Boise" }];
    loadInvoice.mockResolvedValue(invoiceState());
    listClasses.mockResolvedValue(CLASSES);
    const res = await createQuickBooksInvoice(WO);
    expect(res).toMatchObject({ ok: expect.any(String) });
    expect(sentPayload()).not.toHaveProperty("ClassRef");
    expect(classUpserts()).toEqual([]);
  });

  it("a failed Class lookup never blocks the invoice", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    listClasses.mockRejectedValue(new Error("QuickBooks timeout"));
    const res = await createQuickBooksInvoice(WO);
    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 40126 created") });
    expect(sentPayload()).not.toHaveProperty("ClassRef");
    expect(classUpserts()).toEqual([]);
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", expect.objectContaining({ p_qb_invoice_id: "145" }));
  });

  it("does not look up a Class for an order without a shop", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ affiliateId: null }));
    listClasses.mockResolvedValue(CLASSES);
    await createQuickBooksInvoice(WO);
    expect(listClasses).not.toHaveBeenCalled();
    expect(sentPayload()).not.toHaveProperty("ClassRef");
  });

  it("does not remember the class when QuickBooks did not create the invoice", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    listClasses.mockResolvedValue(CLASSES);
    createInvoice.mockRejectedValue(new Error("network down"));
    const res = await createQuickBooksInvoice(WO);
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(classUpserts()).toEqual([]);
  });
});
