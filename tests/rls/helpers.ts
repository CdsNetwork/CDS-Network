import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run the tests with: npm run test:db`);
  }
  return value;
}

export const url = env("SUPABASE_URL");
const anonKey = env("SUPABASE_ANON_KEY");
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/** Bypasses RLS. Used only to build and remove fixtures. */
export const admin = createClient(url, serviceKey, noSession);

export const anon = (): SupabaseClient => createClient(url, anonKey, noSession);

/** Unique per run so tests never collide with seed data or a parallel run. */
export const runId = randomUUID().slice(0, 8).toUpperCase();

export type Login = { id: string; email: string; client: SupabaseClient };

const createdUsers: string[] = [];

/** Creates an auth user plus profile and returns a client signed in as that user. */
export async function createLogin(
  kind: "cds" | "shop",
  affiliateId: string | null,
): Promise<Login> {
  const email = `rls-${kind}-${runId.toLowerCase()}-${createdUsers.length}@test.invalid`;
  const password = randomBytes(24).toString("base64url");

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser returned no user");
  createdUsers.push(data.user.id);

  await must(
    admin.from("profiles").insert({
      id: data.user.id,
      full_name: `RLS ${kind} ${runId}`,
      email,
      kind,
      affiliate_id: affiliateId,
    }),
  );

  const client = createClient(url, anonKey, noSession);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, email, client };
}

export async function deleteLogin(id: string): Promise<void> {
  const index = createdUsers.indexOf(id);
  if (index >= 0) createdUsers.splice(index, 1);
  await admin.auth.admin.deleteUser(id);
}

export async function deleteLogins(): Promise<void> {
  for (const id of createdUsers.splice(0)) {
    await admin.auth.admin.deleteUser(id);
  }
}

/** Unwraps a Supabase response and fails loudly on error. */
export async function must<T>(
  query: PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<NonNullable<T>> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  // Selects always return data when there is no error; plain inserts return null.
  return data as NonNullable<T>;
}
