/**
 * The cron route that sends shop notices and reminders (Sarah, CDS, 2026-11-19): only Vercel's
 * cron (Authorization: Bearer <CRON_SECRET>) runs it, and it is scheduled in vercel.json.
 * Nothing is sent: the run is mocked.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const runShopEmails = vi.fn(async () => ({ reminders: 2, sent: 3, skipped: 1, failed: 0 }));
vi.mock("@/lib/shop-email-run", () => ({ runShopEmails }));
vi.mock("@/lib/shop-email-store", () => ({ supabaseShopEmailStore: () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const { GET } = await import("@/app/api/cron/shop-emails/route");
const SECRET = "s".repeat(40);
const call = (auth?: string) => GET(new Request("http://localhost/api/cron/shop-emails", { headers: auth ? { authorization: auth } : {} }));

describe("GET /api/cron/shop-emails", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    runShopEmails.mockClear();
  });

  it("answers 401 without the cron secret, and sends nothing", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(runShopEmails).not.toHaveBeenCalled();
  });

  it("runs the notices and reminders with a time budget and returns the summary", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reminders: 2, sent: 3, skipped: 1, failed: 0 });
    expect(runShopEmails).toHaveBeenCalledWith(expect.anything(), { budgetMs: 40_000 });
  });

  it("is scheduled in vercel.json every 5 minutes", () => {
    const crons = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")).crons as { path: string; schedule: string }[];
    expect(crons.find((c) => c.path === "/api/cron/shop-emails")?.schedule).toBe("*/5 * * * *");
  });
});
