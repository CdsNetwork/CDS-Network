/**
 * The Data API privileges in public are exactly the ones in grants.snapshot.json.
 *
 * From 2026-10-30 Supabase no longer grants new public objects to anon, authenticated and
 * service_role by default, so every migration grants its objects explicitly
 * (20261020000000_explicit_api_grants.sql). This test reads the live privileges of PUBLIC,
 * anon, authenticated and service_role on every table, view, sequence and function in public
 * and fails on any difference: a new object, a missing grant, or a wider one. When a migration
 * adds or changes an object on purpose, add its grants to the snapshot in the same change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, type Login } from "./helpers";
import snapshot from "./grants.snapshot.json";

type Row = { kind: string; object: string; grantee: string; privileges: string };

let cds: Login;

beforeAll(async () => {
  cds = await createLogin("cds", null);
});

afterAll(async () => {
  await deleteLogins();
});

describe("Data API grants", () => {
  it("match the snapshot exactly", async () => {
    const { data, error } = await admin.rpc("api_grants_matrix");
    if (error) throw new Error(error.message);
    const live: Record<string, Record<string, string>> = {};
    for (const row of data as Row[]) {
      const key = `${row.kind} ${row.object}`;
      live[key] = { ...live[key], [row.grantee]: row.privileges };
    }
    expect(live).toEqual(snapshot);
  });

  it("give anon nothing in public", () => {
    const anonGrants = Object.entries(snapshot).filter(
      ([, grantees]) => "anon" in grantees || "PUBLIC" in grantees,
    );
    expect(anonGrants).toEqual([]);
  });

  it("keep the grants matrix away from anon and signed-in users", async () => {
    for (const client of [anon(), cds.client]) {
      const { data, error } = await client.rpc("api_grants_matrix");
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
    }
  });
});
