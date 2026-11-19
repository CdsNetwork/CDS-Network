/**
 * Admin > Shops > Shop login, username logins (Ashley, 2026-11-19): CDS creates a login with a
 * username and a recovery email; the portal emails a set-password link to the recovery email
 * (CDS never knows the shop's password). CDS can change the recovery email and send a new link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://evil.example" }) }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: async () => ({ id: "cds-1", kind: "cds" }) }));
vi.mock("@/lib/qbo/location-sync", () => ({ LOCATION_SYNC_OFF: "off" }));
vi.mock("@/lib/qbo/location-sync-server", () => ({ syncLocationsFromQuickBooks: async () => ({}) }));

type Op = { op: string; args: unknown[] };
type Result = { data: unknown; error: { code?: string; message: string } | null };
let resolve: (table: string, ops: Op[]) => Result;
const writes: { table: string; ops: Op[] }[] = [];

function chain(table: string) {
  const ops: Op[] = [];
  const done = () => {
    if (ops.some((o) => ["insert", "update", "delete"].includes(o.op))) writes.push({ table, ops });
    return Promise.resolve(resolve(table, ops));
  };
  const c: Record<string, unknown> = {};
  for (const name of ["select", "eq", "insert", "update", "delete", "order", "limit", "not", "is"]) {
    c[name] = (...args: unknown[]) => {
      ops.push({ op: name, args });
      return c;
    };
  }
  c.maybeSingle = done;
  c.single = done;
  c.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => done().then(ok, bad);
  return c;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (t: string) => chain(t) }) }));

const createUser = vi.fn();
const deleteUser = vi.fn(async () => ({ error: null }));
const generateLink = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { createUser, deleteUser, generateLink } }, from: (t: string) => chain(t) }),
}));

const sent: { to: string; subject: string; text: string }[] = [];
let sendFails = false;
vi.mock("@/lib/auth-email", () => ({
  sendAuthEmail: async (to: string, email: { subject: string; text: string }) => {
    if (sendFails) throw new Error("Resend answered HTTP 500");
    sent.push({ to, subject: email.subject, text: email.text });
  },
}));

const { createShopUsernameLogin, sendShopPasswordLink, setShopRecoveryEmail } = await import("@/app/cds/admin/actions");

const SHOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const filters = (ops: Op[]) => Object.fromEntries(ops.filter((o) => o.op === "eq").map((o) => [o.args[0], o.args[1]]));

let takenUsernames: string[];
let activeLoginExists: boolean;
let profileInsertError: Result["error"];
let switchValue: unknown;

beforeEach(() => {
  writes.length = 0;
  sent.length = 0;
  sendFails = false;
  takenUsernames = [];
  activeLoginExists = false;
  profileInsertError = null;
  switchValue = { enabled: true };
  createUser.mockReset();
  createUser.mockImplementation(async ({ email }: { email: string }) => ({ data: { user: { id: "user-1", email } }, error: null }));
  deleteUser.mockClear();
  generateLink.mockReset();
  generateLink.mockImplementation(async () => ({ data: { properties: { hashed_token: "hashed123" } }, error: null }));
  resolve = (table, ops) => {
    const f = filters(ops);
    if (table === "app_settings") {
      return { data: f.key === "shop_username_logins" && switchValue !== undefined ? { value: switchValue } : null, error: null };
    }
    if (table === "affiliates") return { data: { id: SHOP, short_code: "ALN", display_name: "CDS Allentown" }, error: null };
    if (table === "profiles" && ops.some((o) => o.op === "insert")) return { data: null, error: profileInsertError };
    if (table === "profiles" && ops.some((o) => o.op === "update")) return { data: [{ id: "user-1" }], error: null };
    if (table === "profiles" && "username" in f) {
      const hit = takenUsernames.some((u) => u.toLowerCase() === String(f.username).toLowerCase());
      return { data: hit ? { id: "other" } : null, error: null };
    }
    if (table === "profiles" && f.affiliate_id === SHOP && f.active === true) {
      return { data: activeLoginExists ? { id: "old", email: "x@example.com", username: null } : null, error: null };
    }
    if (table === "profiles" && f.id === "user-1") {
      return {
        data: {
          id: "user-1",
          email: "shop-aln-0@login.invalid",
          username: "CDS Allentown",
          recovery_email: "owner@example.com",
          active: true,
          affiliates: { display_name: "CDS Allentown" },
        },
        error: null,
      };
    }
    if (table === "profiles" && f.id === "email-login") {
      return { data: { id: "email-login", email: "shop@example.com", username: null, recovery_email: null, active: true, affiliates: null }, error: null };
    }
    return { data: null, error: null };
  };
});

describe("createShopUsernameLogin", () => {
  it("creates an auth user under login.invalid, the profile with username and recovery email, and emails a set-password link", async () => {
    const r = await createShopUsernameLogin(SHOP, {}, form({ username: "  CDS   Allentown ", recovery_email: "Owner@Example.com" }));
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.message).toContain("owner@example.com");

    const { email, email_confirm, password } = createUser.mock.calls[0][0];
    expect(email).toMatch(/^shop-aln-[0-9a-f]{16}@login\.invalid$/);
    expect(email_confirm).toBe(true);
    expect(String(password).length).toBeGreaterThanOrEqual(32);
    expect(r.message).not.toContain(String(password));

    const insert = writes.find((w) => w.table === "profiles")!.ops.find((o) => o.op === "insert")!.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      id: "user-1",
      email,
      kind: "shop",
      affiliate_id: SHOP,
      username: "CDS Allentown",
      recovery_email: "owner@example.com",
      full_name: "CDS Allentown",
    });

    expect(generateLink).toHaveBeenCalledWith({ type: "recovery", email });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.com");
    expect(sent[0].subject).toBe("Set your CDS portal password: CDS Allentown");
    // The link host never comes from the request's origin header.
    expect(sent[0].text).not.toContain("evil.example");
    expect(sent[0].text).toContain("/auth/confirm?token_hash=hashed123&type=recovery");
  });

  it("refuses a bad username or recovery email before creating anything", async () => {
    expect((await createShopUsernameLogin(SHOP, {}, form({ username: "CDS & Sons", recovery_email: "o@example.com" }))).error).toBeTruthy();
    expect((await createShopUsernameLogin(SHOP, {}, form({ username: "CDS Allentown", recovery_email: "nope" }))).error).toMatch(/recovery email/i);
    expect((await createShopUsernameLogin(SHOP, {}, form({ username: "CDS Allentown", recovery_email: "x@login.invalid" }))).error).toMatch(/recovery email/i);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("refuses a username another login already has, in any case", async () => {
    takenUsernames = ["cds allentown"];
    const r = await createShopUsernameLogin(SHOP, {}, form({ username: "CDS Allentown", recovery_email: "o@example.com" }));
    expect(r.error).toMatch(/already used/i);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("keeps one active login per shop", async () => {
    activeLoginExists = true;
    const r = await createShopUsernameLogin(SHOP, {}, form({ username: "CDS Allentown", recovery_email: "o@example.com" }));
    expect(r.error).toMatch(/already has a login/i);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("withdraws the auth user when the profile cannot be saved (a username taken at the same moment)", async () => {
    profileInsertError = { code: "23505", message: 'duplicate key value violates unique constraint "profiles_username_key"' };
    const r = await createShopUsernameLogin(SHOP, {}, form({ username: "CDS Allentown", recovery_email: "o@example.com" }));
    expect(r.error).toMatch(/already used/i);
    expect(deleteUser).toHaveBeenCalledWith("user-1");
    expect(sent).toHaveLength(0);
  });

  it("keeps the login and says so when the email cannot be sent", async () => {
    sendFails = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await createShopUsernameLogin(SHOP, {}, form({ username: "CDS Allentown", recovery_email: "o@example.com" }));
    log.mockRestore();
    expect(r.error).toMatch(/could not be sent/i);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe("sendShopPasswordLink", () => {
  it("emails a reset link for the username login to its recovery email", async () => {
    const r = await sendShopPasswordLink("user-1");
    expect(r.ok).toBe(true);
    expect(generateLink).toHaveBeenCalledWith({ type: "recovery", email: "shop-aln-0@login.invalid" });
    expect(sent).toEqual([expect.objectContaining({ to: "owner@example.com", subject: "Reset your CDS portal password: CDS Allentown" })]);
  });

  it("is only for username logins", async () => {
    const r = await sendShopPasswordLink("email-login");
    expect(r.error).toBeTruthy();
    expect(sent).toHaveLength(0);
  });
});

describe("setShopRecoveryEmail", () => {
  it("validates and saves the recovery email of a username login", async () => {
    expect((await setShopRecoveryEmail("user-1", {}, form({ recovery_email: "bad" }))).error).toBeTruthy();
    const r = await setShopRecoveryEmail("user-1", {}, form({ recovery_email: " New@Example.com " }));
    expect(r.ok).toBe(true);
    const update = writes.find((w) => w.table === "profiles" && w.ops.some((o) => o.op === "update"))!;
    expect(update.ops.find((o) => o.op === "update")!.args[0]).toEqual({ recovery_email: "new@example.com" });
    expect(filters(update.ops)).toMatchObject({ id: "user-1" });
  });
});

describe("while username logins are off (app_settings shop_username_logins)", () => {
  it.each([[{ enabled: false }], [undefined]])("creating a username login is refused (%j)", async (value) => {
    switchValue = value;
    const r = await createShopUsernameLogin(SHOP, {}, form({ username: "CDS Allentown", recovery_email: "o@example.com" }));
    expect(r.error).toBe("Username logins are off until CDS turns them on.");
    expect(createUser).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("no password link is emailed", async () => {
    switchValue = { enabled: false };
    const r = await sendShopPasswordLink("user-1");
    expect(r.error).toBe("Username logins are off until CDS turns them on.");
    expect(generateLink).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
