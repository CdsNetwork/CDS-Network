/**
 * Internal notes on a work order: a history only CDS staff see.
 *
 * CDS reads and adds internal notes on every work order and may delete one (a note posted by
 * mistake). A shop never reads or adds one, not even on a work order released to it. Nobody
 * edits a note, the author is always the caller, the author's name is stored with the note
 * and an empty note is refused.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shopA: string; customer: string; woA: string; woAPending: string };

let f: Fixture;
let cds: Login;
let shopA: Login;

const LABEL = `INOTES-${runId}`;
const TABLE = "work_order_internal_notes";

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(shop: string, status: string, unit: string): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: f.customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shop,
    status,
    unit_number: unit,
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

const addNote = (who: Login, wo: string, body: string, extra: Record<string, unknown> = {}) =>
  who.client.from(TABLE).insert({ work_order_id: wo, body, ...extra }).select().single();

const bodies = async (who: Login, wo: string) =>
  (await must(who.client.from(TABLE).select("body").eq("work_order_id", wo).order("created_at"))).map(
    (n: { body: string }) => n.body,
  );

beforeAll(async () => {
  const a = await insertOne("affiliates", { short_code: `INA-${runId}`, display_name: `Shop Internal Notes A ${runId}` });
  const customer = await insertOne("customers", { code: `INC-${runId}`, name: `Customer Internal Notes ${runId}` });
  f = { shopA: a.id, customer: customer.id, woA: "", woAPending: "" };
  f.woA = await workOrder(a.id, "accepted", "IN-A1");
  f.woAPending = await workOrder(a.id, "pending_review", "IN-A2");
  cds = await createLogin("cds", null);
  shopA = await createLogin("shop", a.id);
}, 120_000);

afterAll(async () => {
  const errors: string[] = [];
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const suffix = `%-${runId}`;
  const rowIds: string[] = [cds?.id, shopA?.id].filter((v): v is string => !!v);
  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["affiliates", "short_code"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
    const wos = (await must(admin.from("work_orders").select("id").eq("location_label", LABEL))).map((r: { id: string }) => r.id);
    if (wos.length) {
      rowIds.push(...(await must(admin.from(TABLE).select("id").in("work_order_id", wos))).map((r: { id: string }) => r.id));
    }
  });
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("work order internal notes", () => {
  it("CDS adds and reads internal notes on any work order, with the author's name and time stored", async () => {
    const before = Date.now();
    const note = await must(addNote(cds, f.woA, "  Customer called, wants it back Friday.\nSpoke to Mike.  "));
    expect(note).toMatchObject({
      work_order_id: f.woA,
      author_id: cds.id,
      author_name: `RLS cds ${runId}`,
      body: "Customer called, wants it back Friday.\nSpoke to Mike.",
    });
    expect(new Date(note.created_at).getTime()).toBeGreaterThan(before - 60_000);
    await must(addNote(cds, f.woA, "Second note."));
    await must(addNote(cds, f.woAPending, "Waiting on PO."));
    expect(await bodies(cds, f.woA)).toEqual(["Customer called, wants it back Friday.\nSpoke to Mike.", "Second note."]);
    expect(await bodies(cds, f.woAPending)).toEqual(["Waiting on PO."]);
  });

  it("a shop cannot read internal notes, even on a work order released to it", async () => {
    expect(await bodies(shopA, f.woA)).toEqual([]);
    expect(await bodies(shopA, f.woAPending)).toEqual([]);
    expect(await must(shopA.client.from(TABLE).select("id"))).toEqual([]);
  });

  it("a shop cannot add an internal note, even on a work order released to it", async () => {
    for (const wo of [f.woA, f.woAPending]) {
      const { error } = await addNote(shopA, wo, "shop should not land");
      expect(error?.code).toBe("42501");
    }
    const landed = await must(admin.from(TABLE).select("id").eq("body", "shop should not land"));
    expect(landed).toEqual([]);
  });

  it("refuses a note written in someone else's name and replaces a name passed in", async () => {
    const asShop = await addNote(cds, f.woA, "spoofed", { author_id: shopA.id });
    expect(asShop.error?.code).toBe("42501");
    const named = await must(addNote(cds, f.woA, "named", { author_name: "Clyde Stires" }));
    expect(named.author_name).toBe(`RLS cds ${runId}`);
  });

  it("refuses an empty, blank or too long note", async () => {
    for (const body of ["", "   ", "\n\t \n", "x".repeat(2001)]) {
      const { error } = await addNote(cds, f.woA, body);
      expect(error?.code, JSON.stringify(body.slice(0, 10))).toBe("23514");
    }
    const max = await must(addNote(cds, f.woA, ` ${"y".repeat(2000)} `));
    expect(max.body).toHaveLength(2000);
  });

  it("nobody edits a note; shops cannot delete one, CDS can, and the delete is logged", async () => {
    const note = await must(addNote(cds, f.woA, "to be removed"));
    for (const who of [shopA, cds]) {
      const { data } = await who.client.from(TABLE).update({ body: "edited" }).eq("id", note.id).select();
      expect(data ?? []).toEqual([]);
    }
    const { data: shopDeleted } = await shopA.client.from(TABLE).delete().eq("id", note.id).select();
    expect(shopDeleted ?? []).toEqual([]);
    expect((await must(admin.from(TABLE).select("body").eq("id", note.id).single())).body).toBe("to be removed");

    const cdsDeleted = await must(cds.client.from(TABLE).delete().eq("id", note.id).select("id"));
    expect(cdsDeleted).toEqual([{ id: note.id }]);
    const logged = await must(admin.from("audit_log").select("row_id").eq("row_id", note.id));
    expect(logged.length).toBeGreaterThan(0);
  });

  it("gives anonymous callers nothing", async () => {
    const client = anon();
    const { data } = await client.from(TABLE).select("id");
    expect(data ?? []).toEqual([]);
    const { error } = await client.from(TABLE).insert({ work_order_id: f.woA, body: "anon" });
    expect(error).not.toBeNull();
  });
});
