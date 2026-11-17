/**
 * BUG (2026-11-17): Ashley clicked Admin > QuickBooks mappings five times in 30 seconds and
 * saw nothing. The tab awaited every QuickBooks list before any of it could render, so the
 * page stayed blank for about 17 seconds. The tabs now render the portal's own mappings at
 * once and stream the QuickBooks pickers in later (inside Suspense): with QuickBooks never
 * answering, the tabs still render.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

/** A Supabase query builder that answers every query with no rows. */
function emptyQuery() {
  const q = {
    select: () => q,
    eq: () => q,
    order: () => q,
    range: () => q,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (resolve: (v: { data: never[]; error: null }) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
  };
  return q;
}
const supabase = { from: () => emptyQuery(), rpc: vi.fn(async () => ({ data: null, error: null })) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/qbo/status", () => ({ qboStatus: vi.fn(async () => ({ connected: true })) }));
// QuickBooks never answers.
const qboApi = vi.fn(() => new Promise(() => {}));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi }));

const { QuickBooksTab } = await import("@/app/cds/admin/QuickBooksTab");
const { ShopBillsSection } = await import("@/app/cds/admin/ShopBillsSection");

const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<"timed out">((r) => setTimeout(() => r("timed out"), ms))]);

describe("Admin QuickBooks tabs do not wait for QuickBooks", () => {
  beforeEach(() => {
    qboApi.mockClear();
  });

  it("the mappings tab renders while the QuickBooks lists are still loading", async () => {
    const out = await within(QuickBooksTab(), 1000);
    expect(out).not.toBe("timed out");
  });

  it("the shop bills tab renders while the QuickBooks lists are still loading", async () => {
    const out = await within(ShopBillsSection({ connected: true }), 1000);
    expect(out).not.toBe("timed out");
  });

  it("shop bills is its own admin tab, and links to it go there", () => {
    const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
    expect(src("app/cds/admin/page.tsx")).toMatch(/\{ key: "bills", label: "Shop bills" \}/);
    expect(src("app/cds/admin/QuickBooksTab.tsx")).not.toMatch(/ShopBillsSection/);
    expect(src("components/cds-wo/ShopBillPanel.tsx")).toMatch(/\/cds\/admin\?tab=bills/);
  });
});
