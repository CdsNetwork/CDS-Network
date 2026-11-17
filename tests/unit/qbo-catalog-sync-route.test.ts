/**
 * The hourly QuickBooks catalog sync cron (CDS 2026-11-17): only Vercel's cron
 * (Authorization: Bearer <CRON_SECRET>) runs it, it is scheduled hourly in vercel.json, and it
 * answers 200 without doing anything while QuickBooks is not connected. Nothing calls
 * QuickBooks here.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

type Result = { status: string; [k: string]: unknown };
const syncCatalogFromQuickBooks = vi.fn(async (): Promise<Result> => ({ status: "ok", created: 1, linked: 0, renamed: 0, skipped: 3, differences: 0 }));
vi.mock("@/lib/qbo/catalog-sync-server", () => ({ syncCatalogFromQuickBooks }));

const { GET } = await import("@/app/api/cron/qbo-catalog-sync/route");
const { PUBLIC_PATHS } = await import("@/proxy");
const SECRET = "c".repeat(40);
const call = (auth?: string) => GET(new Request("http://localhost/api/cron/qbo-catalog-sync", { headers: auth ? { authorization: auth } : {} }));

describe("GET /api/cron/qbo-catalog-sync", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    syncCatalogFromQuickBooks.mockClear();
  });

  it("answers 401 without the cron secret, and runs nothing", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
    expect(syncCatalogFromQuickBooks).not.toHaveBeenCalled();
  });

  it("runs the sync as the cron and returns its summary", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", created: 1, linked: 0, renamed: 0, skipped: 3, differences: 0 });
    expect(syncCatalogFromQuickBooks).toHaveBeenCalledWith("cron", { dryRun: false });
  });

  it("with ?dry=1 asks for a dry run (the plan, nothing written)", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await GET(new Request("http://localhost/api/cron/qbo-catalog-sync?dry=1", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    expect(syncCatalogFromQuickBooks).toHaveBeenCalledWith("cron", { dryRun: true });
  });

  it("answers 200 when QuickBooks is not connected (skipped)", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    syncCatalogFromQuickBooks.mockResolvedValueOnce({ status: "skipped", reason: "QuickBooks is not connected." });
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "skipped", reason: "QuickBooks is not connected." });
  });

  it("answers 500 when the run failed", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    syncCatalogFromQuickBooks.mockResolvedValueOnce({ status: "failed", error: "QuickBooks could not be reached" });
    expect((await call(`Bearer ${SECRET}`)).status).toBe(500);
  });

  it("is scheduled hourly in vercel.json and is not sent to the login page", () => {
    const crons = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")).crons as { path: string; schedule: string }[];
    const entry = crons.find((c) => c.path === "/api/cron/qbo-catalog-sync");
    expect(entry?.schedule).toMatch(/^\d{1,2} \* \* \* \*$/);
    expect(PUBLIC_PATHS).toContain("/api/cron/");
  });
});
