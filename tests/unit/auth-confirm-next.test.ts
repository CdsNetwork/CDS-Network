/**
 * BUG-M2-15: the invite and reset landing route only redirects inside the portal, whatever
 * `next` carries (QA reproduced 307 to https://evil.example with dot segment variants).
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: async () => ({ error: null }) } }),
}));

const { GET } = await import("@/app/auth/confirm/route");

const ORIGIN = "https://portal.example";
const location = async (next: string) => {
  const url = new URL("/auth/confirm", ORIGIN);
  url.searchParams.set("token_hash", "t");
  url.searchParams.set("type", "magiclink");
  url.searchParams.set("next", next);
  const response = await GET(new NextRequest(url));
  return response.headers.get("location");
};

describe("auth/confirm next", () => {
  it.each([
    ["/cds/admin?tab=settings", `${ORIGIN}/cds/admin?tab=settings`],
    ["/.//evil.example", `${ORIGIN}/account/password`],
    ["/..//evil.example", `${ORIGIN}/account/password`],
    ["/%2e%2e//evil.example", `${ORIGIN}/account/password`],
    ["/%252e%252e//evil.example", `${ORIGIN}/account/password`],
    ["//evil.example", `${ORIGIN}/account/password`],
    ["/\\evil.example", `${ORIGIN}/account/password`],
  ])("next %s -> %s", async (next, expected) => {
    expect(await location(next)).toBe(expected);
  });
});
