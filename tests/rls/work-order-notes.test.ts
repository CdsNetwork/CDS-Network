/**
 * Work order notes: shared between CDS and the shop the work order is assigned to.
 *
 * CDS reads and adds notes on every work order and may delete one (a note posted by
 * mistake). A shop reads and adds notes only on work orders released to it, never on
 * another shop's or on one still in review. Nobody edits a note, the author is always the
 * caller, the author's name is stored with the note (shops cannot read CDS profiles) and an
 * empty note is refused.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shopA: string; shopB: string; customer: string; woA: string; woAPending: string; woB: string };

let f: Fixture;
let cds: Login;
let shopA: Login;
let shopB: Login;

const LABEL = `NOTES-${runId}`;

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
  who.client.from("work_order_notes").insert({ work_order_id: wo, body, ...extra }).select().single();

const bodies = async (who: Login, wo: string) =>
  (await must(who.client.from("work_order_notes").select("body").eq("work_order_id", wo).order("created_at"))).map(
    (n: { body: string }) => n.body,
  );

beforeAll(async () => {
  const a = await insertOne("affiliates", { short_code: `NA-${runId}`, display_name: `Shop Notes A ${runId}` });
  const b = await insertOne("affiliates", { short_code: `NB-${runId}`, display_name: `Shop Notes B ${runId}` });
  const customer = await insertOne("customers", { code: `NC-${runId}`, name: `Customer Notes ${runId}` });
  f = { shopA: a.id, shopB: b.id, customer: customer.id, woA: "", woAPending: "", woB: "" };
  f.woA = await workOrder(a.id, "accepted", "N-A1");
  f.woAPending = await workOrder(a.id, "pending_review", "N-A2");
  f.woB = await workOrder(b.id, "in_process", "N-B1");
  cds = await createLogin("cds", null);
  shopA = await createLogin("shop", a.id);
  shopB = await createLogin("shop", b.id);
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
  const rowIds: string[] = [cds?.id, shopA?.id, shopB?.id].filter((v): v is string => !!v);
  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["affiliates", "short_code"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
    const wos = (await must(admin.from("work_orders").select("id").eq("location_label", LABEL))).map((r: { id: string }) => r.id);
    if (wos.length) {
      rowIds.push(...(await must(admin.from("work_order_notes").select("id").in("work_order_id", wos))).map((r: { id: string }) => r.id));
    }
  });
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("work order notes", () => {
  it("a shop adds and reads notes on its own work order, with the author's name stored", async () => {
    const note = await must(addNote(shopA, f.woA, "  Unit arrived with a cracked inlet.\nPhotos attached.  "));
    expect(note).toMatchObject({
      work_order_id: f.woA,
      author_id: shopA.id,
      author_name: `RLS shop ${runId}`,
      affiliate_id: f.shopA,
      body: "Unit arrived with a cracked inlet.\nPhotos attached.",
    });
    expect(await bodies(shopA, f.woA)).toEqual(["Unit arrived with a cracked inlet.\nPhotos attached."]);
  });

  it("CDS adds and reads notes on any work order, and the shop sees CDS's name", async () => {
    await must(addNote(cds, f.woB, "Customer asks for a call before pickup."));
    await must(addNote(cds, f.woAPending, "Waiting on PO."));
    expect(await bodies(cds, f.woB)).toEqual(["Customer asks for a call before pickup."]);
    expect(await bodies(cds, f.woA)).toEqual(["Unit arrived with a cracked inlet.\nPhotos attached."]);

    const seen = await must(shopB.client.from("work_order_notes").select("author_name, author_id, body").eq("work_order_id", f.woB));
    expect(seen).toEqual([{ author_name: `RLS cds ${runId}`, author_id: cds.id, body: "Customer asks for a call before pickup." }]);
  });

  it("shop A cannot read or add notes on shop B's work order, nor on its own order still in review", async () => {
    expect(await bodies(shopA, f.woB)).toEqual([]);
    expect(await bodies(shopA, f.woAPending)).toEqual([]);
    const all = await must(shopA.client.from("work_order_notes").select("work_order_id"));
    expect(new Set(all.map((n: { work_order_id: string }) => n.work_order_id))).toEqual(new Set([f.woA]));

    for (const wo of [f.woB, f.woAPending]) {
      const { error } = await addNote(shopA, wo, "should not land");
      expect(error?.code).toBe("42501");
    }
    const landed = await must(admin.from("work_order_notes").select("id").eq("body", "should not land"));
    expect(landed).toEqual([]);
  });

  it("refuses a note written in someone else's name", async () => {
    const asCds = await addNote(shopA, f.woA, "spoofed", { author_id: cds.id });
    expect(asCds.error?.code).toBe("42501");
    const asShop = await addNote(cds, f.woA, "spoofed", { author_id: shopA.id });
    expect(asShop.error?.code).toBe("42501");

    // A name passed in is replaced by the author's own name.
    const named = await must(addNote(shopA, f.woA, "named", { author_name: "Clyde Stires" }));
    expect(named.author_name).toBe(`RLS shop ${runId}`);
    // The shop stamp comes from the work order, not from the caller.
    const stamped = await must(addNote(cds, f.woA, "stamped", { affiliate_id: f.shopB }));
    expect(stamped.affiliate_id).toBe(f.shopA);
  });

  it("refuses an empty, blank or too long note", async () => {
    for (const body of ["", "   ", "\n\t \n", "x".repeat(2001)]) {
      const { error } = await addNote(cds, f.woA, body);
      expect(error?.code, JSON.stringify(body.slice(0, 10))).toBe("23514");
    }
    const max = await must(addNote(cds, f.woA, ` ${"y".repeat(2000)} `));
    expect(max.body).toHaveLength(2000);
  });

  it("nobody edits a note; shops cannot delete one, CDS can", async () => {
    const note = await must(addNote(shopA, f.woA, "to be removed"));
    for (const who of [shopA, cds]) {
      const { data } = await who.client.from("work_order_notes").update({ body: "edited" }).eq("id", note.id).select();
      expect(data ?? []).toEqual([]);
    }
    const { data: shopDeleted } = await shopA.client.from("work_order_notes").delete().eq("id", note.id).select();
    expect(shopDeleted ?? []).toEqual([]);
    expect((await must(admin.from("work_order_notes").select("body").eq("id", note.id).single())).body).toBe("to be removed");

    const cdsDeleted = await must(cds.client.from("work_order_notes").delete().eq("id", note.id).select("id"));
    expect(cdsDeleted).toEqual([{ id: note.id }]);
  });

  it("a note added while shop A had the order stays with shop A after reassignment", async () => {
    const wo = await workOrder(f.shopA, "accepted", "N-A3");
    await must(addNote(shopA, wo, "A's note"));
    await must(admin.from("work_orders").update({ affiliate_id: f.shopB }).eq("id", wo));
    expect(await bodies(shopB, wo)).toEqual([]);
    await must(addNote(shopB, wo, "B's note"));
    expect(await bodies(shopB, wo)).toEqual(["B's note"]);
    expect(await bodies(cds, wo)).toEqual(["A's note", "B's note"]);
  });

  it("gives anonymous callers nothing", async () => {
    const client = anon();
    const { data } = await client.from("work_order_notes").select("id");
    expect(data ?? []).toEqual([]);
    const { error } = await client.from("work_order_notes").insert({ work_order_id: f.woA, body: "anon" });
    expect(error).not.toBeNull();
  });
});
