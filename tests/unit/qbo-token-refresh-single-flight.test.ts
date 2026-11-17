/**
 * BUG (2026-11-17): Admin > QuickBooks mappings loads two groups of QuickBooks lists at the
 * same time, each through qboApi(). With an access token about to expire both refreshed it
 * with the same refresh token; Intuit rotates refresh tokens, so the second refresh could fail
 * and show "connection expired". One refresh at a time per server: concurrent callers share it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

const { encryptToken } = await import("@/lib/qbo/secure");
const { qboApi } = await import("@/lib/qbo/tokens");
const { QBO_TOKEN_URL } = await import("@/lib/qbo/config");

const SECRET = "s".repeat(40);
const stored = {
  environment: "sandbox",
  realm_id: "123",
  company_name: "Test Co",
  ast_enabled: true,
  access_token: encryptToken(SECRET, "access-old"),
  // Expires within the refresh margin: needs a refresh.
  access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
  refresh_token: encryptToken(SECRET, "refresh-1"),
  refresh_token_expires_at: null,
};

describe("qboApi token refresh", () => {
  beforeEach(() => {
    vi.stubEnv("QBO_CLIENT_ID", "client");
    vi.stubEnv("QBO_CLIENT_SECRET", SECRET);
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    vi.stubEnv("QBO_REDIRECT_URI", "https://portal.example.com/cds/quickbooks/callback");
    rpc.mockReset();
    rpc.mockImplementation(async (name: string) =>
      name === "qbo_get_connection" ? { data: stored, error: null } : { data: true, error: null },
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refreshes once when two requests need a fresh token at the same time", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url !== QBO_TOKEN_URL) throw new Error(`unexpected ${url}`);
      n += 1;
      await new Promise((r) => setTimeout(r, 20));
      // Intuit rotates the refresh token: a second refresh with refresh-1 would fail.
      if (n > 1) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(
        JSON.stringify({ access_token: "access-new", refresh_token: "refresh-2", expires_in: 3600, x_refresh_token_expires_in: 8_640_000, token_type: "bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([qboApi(), qboApi()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("access-new");
    expect(b.accessToken).toBe("access-new");
    expect(rpc.mock.calls.filter(([name]) => name === "qbo_save_tokens")).toHaveLength(1);

    // Later refreshes are not blocked by the finished one.
    n = 0;
    await qboApi();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
