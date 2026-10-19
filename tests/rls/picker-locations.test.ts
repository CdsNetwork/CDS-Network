/**
 * BUG-M2-10: the Create Work Order location picker gets every active US location, not the
 * first 1000 (PostgREST max_rows). Read as a CDS login, through RLS, like the page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPickerLocations } from "@/app/cds/work-orders/new/locations";
import { admin, createLogin, deleteLogins, type Login } from "./helpers";

let cds: Login;

beforeAll(async () => {
  cds = await createLogin("cds", null);
});

afterAll(async () => {
  await deleteLogins();
});

describe("Create Work Order location picker", () => {
  it("offers as many locations as there are active US locations", async () => {
    const { count, error } = await admin
      .from("customer_locations")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .eq("market", "US");
    expect(error).toBeNull();
    const res = await loadPickerLocations(cds.client);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(count ?? -1);
    expect(new Set(res.data!.map((l) => l.id)).size).toBe(count);
  });
});
