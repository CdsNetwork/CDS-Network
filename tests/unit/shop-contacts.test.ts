/**
 * Admin > Shops > Contacts (CDS, 2026-11-23). A shop can have several contacts
 * (public.affiliate_contacts; up to 6 in production) and the shop emails go to every contact
 * marked receives_dispatch (src/lib/shop-email-store.ts), but the shop editor only managed one
 * "Dispatch email", so CDS could not remove the extra addresses.
 *
 * Now the editor lists every contact (email, optional label, "Gets job emails") and CDS can add
 * one, remove one, and turn job emails on or off for each. Saving the shop's details no longer
 * touches its contacts; the Add shop form still takes a first dispatch email. The table is
 * CDS-only (cds_all policy) and every change is in the Change log (private.audit trigger,
 * "Shop contact").
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
const requireCds = vi.fn(async () => ({ id: "cds-1", kind: "cds" }));
vi.mock("@/lib/auth", () => ({ requireCds }));
vi.mock("@/lib/qbo/location-sync", () => ({ LOCATION_SYNC_OFF: "off" }));
vi.mock("@/lib/qbo/location-sync-server", () => ({ syncLocationsFromQuickBooks: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

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

const { addShopContact, removeShopContact, saveShop, setShopContactDispatch } = await import("@/app/cds/admin/actions");

const SHOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const op = (w: { ops: Op[] }, name: string) => w.ops.find((o) => o.op === name);
const contactWrites = () => writes.filter((w) => w.table === "affiliate_contacts");
const shopFields = { short_code: "dal", display_name: "Example Diesel Dallas", kind: "service_shop" };

let insertError: Result["error"];

beforeEach(() => {
  writes.length = 0;
  insertError = null;
  requireCds.mockClear();
  resolve = (table, ops) => {
    if (table === "affiliates" && ops.some((o) => o.op === "insert")) return { data: { id: SHOP }, error: null };
    if (table === "affiliate_contacts" && ops.some((o) => o.op === "insert")) return { data: null, error: insertError };
    return { data: null, error: null };
  };
});

describe("addShopContact", () => {
  it("adds an email with its label, getting job emails when ticked", async () => {
    const r = await addShopContact(SHOP, {}, form({ email: " Office@Shop.Example ", label: " Office ", receives_dispatch: "on" }));
    expect(r).toMatchObject({ ok: true, message: "office@shop.example added." });
    expect(requireCds).toHaveBeenCalled();
    expect(op(contactWrites()[0], "insert")?.args[0]).toEqual({
      affiliate_id: SHOP,
      email: "office@shop.example",
      label: "Office",
      receives_dispatch: true,
    });
  });

  it("adds one that gets no job emails when not ticked, with no label", async () => {
    await addShopContact(SHOP, {}, form({ email: "owner@shop.example" }));
    expect(op(contactWrites()[0], "insert")?.args[0]).toMatchObject({ label: null, receives_dispatch: false });
  });

  it("refuses an invalid email, a too long label, and an email the shop already has", async () => {
    expect((await addShopContact(SHOP, {}, form({ email: "not-an-email" }))).error).toMatch(/valid email/);
    expect((await addShopContact(SHOP, {}, form({ email: "a@shop.example", label: "x".repeat(101) }))).error).toMatch(/100/);
    expect(contactWrites()).toHaveLength(0);
    insertError = { code: "23505", message: "duplicate key" };
    expect((await addShopContact(SHOP, {}, form({ email: "a@shop.example" }))).error).toBe("This shop already has that email.");
  });

  it("refuses a bad shop id", async () => {
    expect((await addShopContact("x", {}, form({ email: "a@shop.example" }))).error).toBeTruthy();
    expect(contactWrites()).toHaveLength(0);
  });
});

describe("removeShopContact and setShopContactDispatch", () => {
  it("removes exactly that contact", async () => {
    const r = await removeShopContact(CONTACT);
    expect(r).toMatchObject({ ok: true });
    const w = contactWrites()[0];
    expect(op(w, "delete")).toBeTruthy();
    expect(op(w, "eq")?.args).toEqual(["id", CONTACT]);
  });

  it("turns job emails on or off for that contact only", async () => {
    await setShopContactDispatch(CONTACT, false);
    const w = contactWrites()[0];
    expect(op(w, "update")?.args[0]).toEqual({ receives_dispatch: false });
    expect(op(w, "eq")?.args).toEqual(["id", CONTACT]);
    expect((await setShopContactDispatch(CONTACT, true)).message).toMatch(/gets job emails/);
  });

  it("are CDS only and refuse a bad id", async () => {
    await removeShopContact(CONTACT);
    await setShopContactDispatch(CONTACT, true);
    expect(requireCds).toHaveBeenCalledTimes(2);
    expect((await removeShopContact("x")).error).toBeTruthy();
    expect((await setShopContactDispatch("x", true)).error).toBeTruthy();
  });
});

describe("saveShop", () => {
  it("editing a shop never touches its contacts (several stay, none are removed)", async () => {
    resolve = (table, ops) =>
      table === "affiliate_contacts" && !ops.some((o) => ["insert", "update", "delete"].includes(o.op))
        ? { data: [{ id: CONTACT, email: "a@shop.example" }, { id: "other", email: "b@shop.example" }], error: null }
        : { data: null, error: null };
    const r = await saveShop(SHOP, {}, form({ ...shopFields, dispatch_email: "" }));
    expect(r).toMatchObject({ ok: true, message: "Shop saved." });
    expect(contactWrites()).toHaveLength(0);
  });

  it("editing a shop with no contacts still works", async () => {
    expect((await saveShop(SHOP, {}, form({ ...shopFields, dispatch_email: "" }))).ok).toBe(true);
    expect(contactWrites()).toHaveLength(0);
  });

  it("Add shop saves the first dispatch email as a contact that gets job emails", async () => {
    const r = await saveShop(null, {}, form({ ...shopFields, dispatch_email: "Dispatch@Shop.Example" }));
    expect(r.ok).toBe(true);
    expect(op(contactWrites()[0], "insert")?.args[0]).toEqual({
      affiliate_id: SHOP,
      email: "dispatch@shop.example",
      label: "Dispatch",
      receives_dispatch: true,
    });
  });
});

describe("the shop editor", () => {
  const tab = readFileSync(new URL("../../src/app/cds/admin/ShopsTab.tsx", import.meta.url), "utf8");

  it("lists every contact, not only the ones getting job emails", () => {
    expect(tab).toMatch(/from\("affiliate_contacts"\)\.select\("id, affiliate_id, email, label, receives_dispatch"\)/);
    expect(tab).not.toMatch(/from\("affiliate_contacts"\)[^;]*\.eq\("receives_dispatch", true\)/);
  });

  it("adds, removes and toggles job emails per contact", () => {
    expect(tab).toMatch(/addShopContact\.bind\(null, shop\.id\)/);
    expect(tab).toMatch(/removeShopContact\.bind\(null, c\.id\)/);
    expect(tab).toMatch(/setShopContactDispatch\.bind\(null, c\.id, !c\.receives_dispatch\)/);
    expect(tab).toMatch(/name="receives_dispatch"/);
    expect(tab).toMatch(/Gets job emails/);
  });

  it("the shop details form of an existing shop has no single dispatch email field any more", () => {
    expect(tab).toMatch(/<ShopFields shop=\{shop\} \/>/);
    expect(tab).toMatch(/\{!shop && \(/);
  });
});
