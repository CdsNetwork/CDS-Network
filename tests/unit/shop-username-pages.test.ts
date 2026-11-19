/**
 * The sign in and Forgot password pages with username logins off (the default until CDS turns
 * them on, Ashley 2026-11-19) look as before: one Email field (type email, name email). With
 * them on: one "Email or username" field.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

let on = false;
vi.mock("@/lib/shop-login-setting", () => ({ usernameLoginsOnForVisitors: async () => on }));

const { default: LoginPage } = await import("@/app/login/page");
const { default: ForgotPasswordPage } = await import("@/app/forgot-password/page");

const login = async () =>
  renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) } as Parameters<typeof LoginPage>[0]));
const forgot = async () => renderToStaticMarkup(await ForgotPasswordPage());

beforeEach(() => {
  on = false;
});

describe("off (default)", () => {
  it("sign in asks for an email, as before", async () => {
    const html = await login();
    expect(html).toContain('<label for="email">Email</label>');
    expect(html).toMatch(/<input[^>]*name="email"[^>]*type="email"|<input[^>]*type="email"[^>]*name="email"/);
    expect(html).not.toContain("username");
  });

  it("forgot password asks for an email, as before", async () => {
    const html = await forgot();
    expect(html).toContain('<label for="email">Email</label>');
    expect(html).not.toMatch(/username/i);
  });
});

describe("on", () => {
  it("sign in asks for an email or username", async () => {
    on = true;
    const html = await login();
    expect(html).toContain("Email or username");
    expect(html).toContain('name="login"');
    expect(html).not.toContain('type="email"');
  });

  it("forgot password asks for an email or username", async () => {
    on = true;
    const html = await forgot();
    expect(html).toContain("Email or username");
    expect(html).toContain('name="login"');
  });
});
