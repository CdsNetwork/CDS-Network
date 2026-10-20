/**
 * Signing in from a link that carries next (the QuickBooks launch and connect URLs) opens
 * that page afterwards; anything outside the portal falls back to the home page.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithPassword: async () => ({ error: null }) } }),
}));

const { signIn } = await import("@/app/login/actions");

const form = (next?: string) => {
  const f = new FormData();
  f.set("email", "a@example.com");
  f.set("password", "x".repeat(12));
  if (next !== undefined) f.set("next", next);
  return f;
};

describe("signIn and next", () => {
  it.each([
    [undefined, "/"],
    ["", "/"],
    ["/cds/admin?tab=settings", "/cds/admin?tab=settings"],
    ["/quickbooks/connect", "/quickbooks/connect"],
    ["https://evil.example", "/"],
    ["//evil.example", "/"],
  ])("next %s -> %s", async (next, expected) => {
    await expect(signIn({}, form(next))).rejects.toThrow(`REDIRECT ${expected}`);
  });
});
