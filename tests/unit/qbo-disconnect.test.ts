/**
 * Disconnect QuickBooks (Admin > Settings) revokes the stored refresh token at Intuit's
 * revoke endpoint and then forgets the connection, even when Intuit cannot be reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

const { encryptToken } = await import("@/lib/qbo/secure");
const { disconnect } = await import("@/lib/qbo/tokens");
const { QBO_REVOKE_URL } = await import("@/lib/qbo/config");

const SECRET = "s".repeat(40);
const stored = () => ({
  environment: "sandbox",
  realm_id: "123",
  company_name: "Test Co",
  ast_enabled: true,
  access_token: encryptToken(SECRET, "access-1"),
  access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  refresh_token: encryptToken(SECRET, "refresh-1"),
  refresh_token_expires_at: null,
});

describe("disconnect", () => {
  beforeEach(() => {
    vi.stubEnv("QBO_CLIENT_ID", "client");
    vi.stubEnv("QBO_CLIENT_SECRET", SECRET);
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    vi.stubEnv("QBO_REDIRECT_URI", "https://portal.example.com/cds/quickbooks/callback");
    rpc.mockReset();
    rpc.mockImplementation(async (name: string) =>
      name === "qbo_get_connection" ? { data: stored(), error: null } : { data: null, error: null },
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("revokes the refresh token at Intuit and deletes the stored connection", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await disconnect("actor-1")).toEqual({ revoked: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(QBO_REVOKE_URL);
    expect(JSON.parse(String(init.body))).toEqual({ token: "refresh-1" });
    expect(rpc).toHaveBeenCalledWith("qbo_delete_connection", { p_actor: "actor-1" });
  });

  it("still forgets the connection when Intuit refuses the revoke", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await disconnect("actor-1")).toEqual({ revoked: false });
    expect(rpc).toHaveBeenCalledWith("qbo_delete_connection", { p_actor: "actor-1" });
  });
});
