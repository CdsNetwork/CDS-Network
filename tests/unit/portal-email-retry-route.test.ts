/**
 * The cron route that retries failed status emails (review 2026-11-16, M4): only Vercel's cron
 * (Authorization: Bearer <CRON_SECRET>) runs it, it is scheduled in vercel.json, and it does
 * nothing while portal emails are turned off. Nothing is sent: Resend is never called here.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const retryPortalEmails = vi.fn(async () => ({ tried: 1, sent: 1, failed: 0, skipped: 0 }));
vi.mock("@/lib/portal-email-retry", () => ({ retryPortalEmails }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const { GET } = await import("@/app/api/cron/portal-email-retry/route");
const { retryPortalEmails: realRetry } = await vi.importActual<typeof import("@/lib/portal-email-retry")>("@/lib/portal-email-retry");
const SECRET = "c".repeat(40);
const call = (auth?: string) => GET(new Request("http://localhost/api/cron/portal-email-retry", { headers: auth ? { authorization: auth } : {} }));

describe("GET /api/cron/portal-email-retry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    retryPortalEmails.mockClear();
  });

  it("answers 401 without the cron secret, and runs nothing", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(retryPortalEmails).not.toHaveBeenCalled();
  });

  it("runs the retry with a time budget and returns its summary", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tried: 1, sent: 1, failed: 0, skipped: 0 });
    expect(retryPortalEmails).toHaveBeenCalledWith(expect.anything(), { budgetMs: 40_000 });
  });

  it("is scheduled in vercel.json", () => {
    const crons = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")).crons as { path: string }[];
    expect(crons.map((c) => c.path)).toContain("/api/cron/portal-email-retry");
  });
});

describe("retryPortalEmails", () => {
  it("does not read anything while portal emails are turned off", async () => {
    const from = vi.fn();
    const out = await realRetry({ from } as never, { env: { PORTAL_EMAILS_ENABLED: "false" } });
    expect(out).toEqual({ tried: 0, sent: 0, failed: 0, skipped: 0 });
    expect(from).not.toHaveBeenCalled();
  });
});
