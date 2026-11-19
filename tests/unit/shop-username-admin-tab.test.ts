/**
 * Admin > Shops > Shop login with username logins off (default until CDS turns them on,
 * Ashley 2026-11-19): only today's "Invite shop login". On: "Create login with username" too,
 * and a username login shows its username, recovery email and "Email password link".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/lib/auth", () => ({ requireCds: async () => ({}) }));
vi.mock("@/lib/qbo/location-sync", () => ({ LOCATION_SYNC_OFF: "off" }));
vi.mock("@/lib/qbo/location-sync-server", () => ({ syncLocationsFromQuickBooks: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const SHOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let switchValue: unknown = { enabled: false };
let logins: Record<string, unknown>[] = [];

function chain(table: string) {
  const result = () => {
    if (table === "app_settings") return { data: switchValue === undefined ? null : { value: switchValue }, error: null };
    if (table === "affiliates") {
      return {
        data: [{ id: SHOP, short_code: "ALN", display_name: "CDS Allentown", kind: "service_shop", active: true, customer_locations: [] }],
        error: null,
      };
    }
    if (table === "profiles") return { data: logins, error: null };
    return { data: [], error: null };
  };
  const c: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "range"]) c[name] = () => c;
  c.maybeSingle = async () => result();
  c.then = (ok: (r: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
  return c;
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (t: string) => chain(t) }) }));

const { ShopsTab } = await import("@/app/cds/admin/ShopsTab");
const render = async () => renderToStaticMarkup(await ShopsTab({ edit: SHOP, filters: { q: "", kind: "", status: "" } }));

const usernameLogin = {
  id: "p1",
  full_name: "CDS Allentown",
  email: "shop-aln-1@login.invalid",
  active: true,
  affiliate_id: SHOP,
  username: "CDS Allentown",
  recovery_email: "owner@example.com",
};

describe("ShopsTab and the shop_username_logins switch", () => {
  it.each([[{ enabled: false }], [undefined]])("off (%j): only today's invite, no username controls", async (value) => {
    switchValue = value;
    logins = [];
    const html = await render();
    expect(html).toContain("Invite shop login");
    expect(html).not.toContain("Create login with username");
    expect(html).not.toContain("Recovery email");
  });

  it("on: create with username, prefilled with the shop name, next to the email invite", async () => {
    switchValue = { enabled: true };
    logins = [];
    const html = await render();
    expect(html).toContain("Create login with username");
    expect(html).toMatch(/name="username"[^>]*value="CDS Allentown"|value="CDS Allentown"[^>]*name="username"/);
    expect(html).toContain("Invite shop login");
  });

  it("on: a username login shows username, recovery email and the password link, never the internal email", async () => {
    switchValue = { enabled: true };
    logins = [usernameLogin];
    const html = await render();
    expect(html).toContain("Email password link");
    expect(html).toContain("owner@example.com");
    expect(html).not.toContain("login.invalid");
    expect(html).toContain("Deactivate");
  });

  it("off: an existing username login gets no password link and says why", async () => {
    switchValue = { enabled: false };
    logins = [usernameLogin];
    const html = await render();
    expect(html).not.toContain("Email password link");
    expect(html).toContain("Username logins are off until CDS turns them on.");
    expect(html).not.toContain("login.invalid");
  });
});
