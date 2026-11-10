/**
 * CDS can delete a work order (a test order, or one entered twice) from its page. The
 * database removes the order and everything on it in one transaction
 * (public.cds_delete_work_order); the app then removes the stored files and goes back to the
 * work order list with a message. QuickBooks is never touched: an invoice stays there and
 * CDS voids it in QuickBooks.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock("next/navigation", () => ({ redirect }));
const requireCds = vi.fn(async () => ({ id: "u1", kind: "cds" }));
vi.mock("@/lib/auth", () => ({ requireCds }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

const WO = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";

let rpcResult: { data: unknown; error: { message: string } | null };
let listed: Record<string, string[]>;
const rpc = vi.fn(async () => rpcResult);
const remove = vi.fn(async () => ({ data: [], error: null }));
const list = vi.fn(async (prefix: string) => ({ data: (listed[prefix] ?? []).map((name) => ({ name, id: name })), error: null }));
const supabase = { rpc, storage: { from: vi.fn(() => ({ remove, list })) }, from: vi.fn() };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { deleteWorkOrder } = await import("@/app/cds/work-orders/[id]/actions");
const { deleteConfirmText, deletedHref, deletedMessage, storagePathsToRemove } = await import("@/lib/work-order-delete");

beforeEach(() => {
  rpc.mockClear();
  remove.mockClear();
  list.mockClear();
  redirect.mockClear();
  listed = {};
  rpcResult = {
    data: { wo_number: 101951, qb_invoice_id: null, qb_invoice_number: null, storage_paths: [`${WO}/a-photo.png`] },
    error: null,
  };
});

describe("deleteConfirmText", () => {
  it("names the work order number", () => {
    const text = deleteConfirmText({ woNumber: 101951, qbInvoice: null });
    expect(text).toContain("WO-101951");
    expect(text).toMatch(/cannot be undone/i);
    expect(text).not.toMatch(/QuickBooks/);
  });

  it("says a QuickBooks invoice stays in QuickBooks and must be voided there", () => {
    const text = deleteConfirmText({ woNumber: 101951, qbInvoice: { id: "77", number: "1034" } });
    expect(text).toContain("WO-101951");
    expect(text).toMatch(/QuickBooks invoice 1034/);
    expect(text).toMatch(/stays in QuickBooks/);
    expect(text).toMatch(/void it in QuickBooks/i);
  });

  it("uses the QuickBooks id when the invoice number is not known", () => {
    expect(deleteConfirmText({ woNumber: 5, qbInvoice: { id: "77", number: null } })).toMatch(/QuickBooks invoice id 77/);
  });

  it("has no em or en dashes", () => {
    const text = deleteConfirmText({ woNumber: 5, qbInvoice: { id: "77", number: "1" } });
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("deleted message on the work order list", () => {
  it("round trips the work order number and invoice through the list URL", () => {
    const href = deletedHref(101951, "1034");
    expect(href.startsWith("/cds?")).toBe(true);
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(deletedMessage(sp)).toEqual({
      kind: "ok",
      text: "WO-101951 was deleted. QuickBooks invoice 1034 is still in QuickBooks: void it there.",
    });
    expect(deletedMessage(Object.fromEntries(new URL(deletedHref(101951, null), "http://x").searchParams))).toEqual({
      kind: "ok",
      text: "WO-101951 was deleted.",
    });
  });

  it("shows nothing for a missing or malformed parameter", () => {
    expect(deletedMessage({})).toBeNull();
    expect(deletedMessage({ deleted: "abc" })).toBeNull();
    expect(deletedMessage({ deleted: ["1", "2"] })).toBeNull();
    // A forged invoice text is dropped, the number still shows.
    expect(deletedMessage({ deleted: "12", qb: "<script>" })).toEqual({ kind: "ok", text: "WO-12 was deleted." });
  });
});

describe("storagePathsToRemove", () => {
  it("keeps only objects in this work order's folder, once each", () => {
    const paths = storagePathsToRemove(WO, [`${WO}/a.png`, `${OTHER}/b.png`, null, `${WO}/a.png`], [`${WO}/labels/x.pdf`, "../evil"]);
    expect(paths.sort()).toEqual([`${WO}/a.png`, `${WO}/labels/x.pdf`]);
  });
});

describe("deleteWorkOrder", () => {
  it("deletes through the database function, removes the files and goes to the list with a message", async () => {
    listed = { [WO]: ["a-photo.png", "orphan.pdf", "labels"], [`${WO}/labels`]: ["s-1.pdf"] };
    await expect(deleteWorkOrder(WO)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(requireCds).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("cds_delete_work_order", { p_work_order: WO });
    expect(remove).toHaveBeenCalledTimes(1);
    const removed = (remove.mock.calls[0] as unknown as [string[]])[0];
    expect([...removed].sort()).toEqual([`${WO}/a-photo.png`, `${WO}/labels/s-1.pdf`, `${WO}/orphan.pdf`]);
    expect(redirect).toHaveBeenCalledWith(deletedHref(101951, null));
  });

  it("carries the QuickBooks invoice number to the list message", async () => {
    rpcResult = { data: { wo_number: 101951, qb_invoice_id: "77", qb_invoice_number: "1034", storage_paths: [] }, error: null };
    await expect(deleteWorkOrder(WO)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith(deletedHref(101951, "1034"));
  });

  it("returns the database refusal and stays on the page", async () => {
    rpcResult = { data: null, error: { message: "This work order has a shipping label in use. Void the label first, then delete the work order." } };
    const res = await deleteWorkOrder(WO);
    expect(res).toEqual({ error: rpcResult.error!.message });
    expect(remove).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("refuses a bad id without calling the database", async () => {
    expect(await deleteWorkOrder("nope")).toEqual({ error: "Work order not found." });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("pages and migration", () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

  it("offers Delete on the work order page with a confirm that names the order", () => {
    const page = read("src/app/cds/work-orders/[id]/page.tsx");
    expect(page).toMatch(/deleteWorkOrder\.bind\(null, wo\.id\)/);
    expect(page).toMatch(/confirmText=\{deleteConfirmText\(\{ woNumber: wo\.wo_number/);
  });

  it("shows the deleted message on the work order list", () => {
    expect(read("src/app/cds/page.tsx")).toMatch(/deletedMessage\(sp\)/);
  });

  it("adds a CDS-only database function that refuses an order with a label in use", () => {
    const sql = read("supabase/migrations/20261111020000_delete_work_order.sql");
    expect(sql).toMatch(/create function public\.cds_delete_work_order\(p_work_order uuid\)/);
    expect(sql).toMatch(/security definer set search_path = ''/);
    expect(sql).toMatch(/perform private\.require_cds\(\)/);
    expect(sql).toMatch(/status = 'active' and not l\.is_test/);
    expect(sql).toMatch(/revoke all on function public\.cds_delete_work_order\(uuid\) from public, anon/);
    expect(sql).toMatch(/grant execute on function public\.cds_delete_work_order\(uuid\) to authenticated/);
    expect(sql).not.toMatch(/[\u2013\u2014]/);
  });
});
