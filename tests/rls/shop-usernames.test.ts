/**
 * Username logins for shops (20261120100000_shop_usernames.sql): usernames are unique in any
 * case across all logins, only shop logins have them, each has a recovery email (which several
 * shops may share), the auth email of a username login is an internal login.invalid address,
 * and a shop never reads another shop's username or recovery email. The sign-in rate limit
 * (public.auth_rate_limit) is for the service role only.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { admin, anon, createLogin, deleteLogins, must, runId, url, type Login } from "./helpers";

const rid = runId.toLowerCase();
const SHARED_RECOVERY = `owner-${rid}@test.invalid`;
const usernameA = `Test Allentown ${runId}`;
const usernameB = `Test Bethlehem ${runId}`;

type UsernameLogin = { id: string; email: string; password: string; client: SupabaseClient };

let shopA: string;
let shopB: string;
let loginA: UsernameLogin;
let loginB: UsernameLogin;
let cds: Login;
const authUsers: string[] = [];
const affiliates: string[] = [];

async function usernameLogin(affiliateId: string, username: string): Promise<UsernameLogin> {
  const email = `shop-${rid}-${randomBytes(8).toString("hex")}@login.invalid`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("no user");
  authUsers.push(data.user.id);
  await must(
    admin.from("profiles").insert({
      id: data.user.id,
      full_name: username,
      email,
      kind: "shop",
      affiliate_id: affiliateId,
      username,
      recovery_email: SHARED_RECOVERY,
    }),
  );
  const client = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, email, password, client };
}

beforeAll(async () => {
  const rows = await must(
    admin
      .from("affiliates")
      .insert([
        { short_code: `UA-${runId}`, display_name: usernameA },
        { short_code: `UB-${runId}`, display_name: usernameB },
      ])
      .select("id, short_code")
      .order("short_code"),
  );
  shopA = (rows as { id: string }[])[0].id;
  shopB = (rows as { id: string }[])[1].id;
  affiliates.push(shopA, shopB);
  loginA = await usernameLogin(shopA, usernameA);
  loginB = await usernameLogin(shopB, usernameB);
  cds = await createLogin("cds", null);
});

afterAll(async () => {
  for (const id of authUsers) await admin.auth.admin.deleteUser(id);
  await deleteLogins();
  if (affiliates.length) await admin.from("affiliates").delete().in("id", affiliates);
});

const code = async (q: PromiseLike<{ error: { code?: string } | null }>) => (await q).error?.code ?? null;

describe("username logins", () => {
  it("sign in with the internal login.invalid address, and two shops share one recovery email", async () => {
    const { data } = await loginA.client.auth.getUser();
    expect(data.user?.email).toBe(loginA.email);
    const both = await must(admin.from("profiles").select("id").eq("recovery_email", SHARED_RECOVERY));
    expect((both as unknown[]).length).toBe(2);
  });

  it("are unique in any case across all logins, active or not", async () => {
    expect(await code(admin.from("profiles").update({ username: usernameA.toUpperCase() }).eq("id", loginB.id))).toBe("23505");
    await must(admin.from("profiles").update({ active: false }).eq("id", loginA.id));
    try {
      expect(await code(admin.from("profiles").update({ username: usernameA.toLowerCase() }).eq("id", loginB.id))).toBe("23505");
    } finally {
      await must(admin.from("profiles").update({ active: true }).eq("id", loginA.id));
    }
  });

  it("are found in any case", async () => {
    const found = await must(admin.from("profiles").select("id").eq("username", usernameA.toLowerCase()));
    expect(found).toEqual([{ id: loginA.id }]);
  });

  it.each([
    ["an @", `bad@name ${runId}`],
    ["leading space", ` Lead ${runId}`],
    ["two spaces", `Two  Spaces ${runId}`],
    ["too short", "ab"],
    ["too long", "x".repeat(61)],
    ["other characters", `Smith & Sons ${runId}`],
  ])("refuse %s", async (_label, username) => {
    expect(await code(admin.from("profiles").update({ username }).eq("id", loginB.id))).toBe("23514");
  });

  it("need a recovery email and an internal login.invalid address", async () => {
    expect(await code(admin.from("profiles").update({ recovery_email: null }).eq("id", loginB.id))).toBe("23514");
    expect(await code(admin.from("profiles").update({ email: `real-${rid}@test.invalid` }).eq("id", loginB.id))).toBe("23514");
  });

  it("are for shop logins only, and only username logins use login.invalid", async () => {
    expect(
      await code(admin.from("profiles").update({ username: `Staff ${runId}`, recovery_email: SHARED_RECOVERY }).eq("id", cds.id)),
    ).toBe("23514");
    expect(await code(admin.from("profiles").update({ email: `x-${rid}@login.invalid` }).eq("id", cds.id))).toBe("23514");
  });
});

describe("what a shop can read and change", () => {
  it("reads its own username and recovery email, never another shop's", async () => {
    const rows = await must(loginA.client.from("profiles").select("id, username, recovery_email"));
    expect(rows).toEqual([{ id: loginA.id, username: usernameA, recovery_email: SHARED_RECOVERY }]);
    const other = await must(loginA.client.from("profiles").select("id").eq("id", loginB.id));
    expect(other).toEqual([]);
    const byName = await must(loginA.client.from("profiles").select("id").eq("username", usernameB));
    expect(byName).toEqual([]);
  });

  it("cannot change its own username or recovery email", async () => {
    await loginA.client.from("profiles").update({ recovery_email: `evil-${rid}@test.invalid`, username: `Evil ${runId}` }).eq("id", loginA.id);
    const row = await must(admin.from("profiles").select("username, recovery_email").eq("id", loginA.id).single());
    expect(row).toEqual({ username: usernameA, recovery_email: SHARED_RECOVERY });
  });

  it("anon reads no profile", async () => {
    const { data } = await anon().from("profiles").select("id").eq("username", usernameA);
    expect(data ?? []).toEqual([]);
  });

  it("CDS reads every username login", async () => {
    const rows = await must(cds.client.from("profiles").select("id").in("id", [loginA.id, loginB.id]));
    expect((rows as unknown[]).length).toBe(2);
  });
});

describe("auth_rate_limit", () => {
  it("counts recorded attempts per key in the window, service role only", async () => {
    const key = `test:${runId}:${randomBytes(4).toString("hex")}`;
    const hit = async () => {
      const { data, error } = await admin.rpc("auth_rate_limit", { p_key: key, p_limit: 2, p_window_seconds: 60, p_record: true });
      if (error) throw new Error(error.message);
      return data as boolean;
    };
    expect(await hit()).toBe(false);
    expect(await hit()).toBe(false);
    expect(await hit()).toBe(true);
    const { data: other } = await admin.rpc("auth_rate_limit", { p_key: `${key}:other`, p_limit: 2, p_window_seconds: 60, p_record: false });
    expect(other).toBe(false);
  });

  it("cannot be called by anon or a login", async () => {
    const args = { p_key: `test:${runId}`, p_limit: 1, p_window_seconds: 60, p_record: true };
    expect((await anon().rpc("auth_rate_limit", args)).error).not.toBeNull();
    expect((await loginA.client.rpc("auth_rate_limit", args)).error).not.toBeNull();
    expect((await cds.client.rpc("auth_rate_limit", args)).error).not.toBeNull();
  });
});

describe("shop_username_logins switch", () => {
  it("exists (the migration inserts it off; never changed by this test) and only CDS reads it", async () => {
    const row = await must(admin.from("app_settings").select("value").eq("key", "shop_username_logins").single());
    expect(typeof (row as { value: { enabled: unknown } }).value.enabled).toBe("boolean");
    const asShop = await loginA.client.from("app_settings").select("value").eq("key", "shop_username_logins");
    expect(asShop.data ?? []).toEqual([]);
    await loginA.client.from("app_settings").update({ value: { enabled: true } }).eq("key", "shop_username_logins");
    const after = await must(admin.from("app_settings").select("value").eq("key", "shop_username_logins").single());
    expect(after).toEqual(row);
    const asCds = await must(cds.client.from("app_settings").select("value").eq("key", "shop_username_logins"));
    expect((asCds as unknown[]).length).toBe(1);
  });
});
