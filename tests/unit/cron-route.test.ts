/**
 * The tracking cron route: only Vercel's cron (Authorization: Bearer <CRON_SECRET>) runs it,
 * and the session proxy lets it through (it has no login).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("no database in this test");
  },
}));

const { GET } = await import("@/app/api/cron/shipstation-tracking/route");
const { PUBLIC_PATHS } = await import("@/proxy");
const SECRET = "c".repeat(40);
const call = (auth?: string) =>
  GET(new Request("http://localhost/api/cron/shipstation-tracking", { headers: auth ? { authorization: auth } : {} }));

describe("GET /api/cron/shipstation-tracking", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without the cron secret, or while CRON_SECRET is not set", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
  });

  it("answers 503 when ShipStation is not configured", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("SHIPSTATION_API_KEY", "");
    expect((await call(`Bearer ${SECRET}`)).status).toBe(503);
  });

  it("is not sent to the login page by the session proxy", () => {
    expect(PUBLIC_PATHS).toContain("/api/cron/");
  });
});
