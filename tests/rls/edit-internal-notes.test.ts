/**
 * Editing an internal note (20261117020000_edit_internal_notes.sql; milestone M3, notes from
 * the work order list).
 *
 * Only the CDS author of a CDS-only internal note edits it, and only through
 * public.cds_edit_internal_note: the text is trimmed and checked like a new note, the edit
 * time is stored, the author, name and creation time stay, and the old and new text are kept
 * in the change log. Another CDS user, a shop and anonymous callers cannot edit it, a direct
 * update is still refused, and notes the shop sees are never edited.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `EDITNOTES-${runId}`;
const TABLE = "work_order_internal_notes";

let wo: string;
let cds: Login;
let otherCds: Login;
let shop: Login;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const addNote = async (who: Login, body: string) =>
  (await must(who.client.from(TABLE).insert({ work_order_id: wo, body }).select().single())) as {
    id: string;
    author_name: string;
    created_at: string;
  };

const edit = (who: Login | { client: ReturnType<typeof anon> }, note: string, body: string) =>
  who.client.rpc("cds_edit_internal_note", { p_note: note, p_body: body });

const row = async (id: string) => must(admin.from(TABLE).select("*").eq("id", id).single());

beforeAll(async () => {
  const shopRow = await insertOne("affiliates", { short_code: `ENA-${runId}`, display_name: `Shop Edit Notes ${runId}` });
  const customer = await insertOne("customers", { code: `ENC-${runId}`, name: `Customer Edit Notes ${runId}` });
  const w = await insertOne("work_orders", {
    customer_id: customer.id,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shopRow.id,
    status: "accepted",
    unit_number: "EN-1",
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: w.id }));
  wo = w.id;
  cds = await createLogin("cds", null);
  otherCds = await createLogin("cds", null);
  shop = await createLogin("shop", shopRow.id);
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
  const rowIds: string[] = [cds?.id, otherCds?.id, shop?.id].filter((v): v is string => !!v);
  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["affiliates", "short_code"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
    if (wo) {
      for (const t of [TABLE, "work_order_notes"]) {
        rowIds.push(...(await must(admin.from(t).select("id").eq("work_order_id", wo))).map((r: { id: string }) => r.id));
      }
    }
  });
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("editing internal notes", () => {
  it("the author edits the text; name and time stay, the edit time is stored and logged", async () => {
    const note = await addNote(cds, "ETA Friday.");
    const before = Date.now();
    await must(edit(cds, note.id, "  ETA Monday.\r\nCustomer agreed.  "));
    const after = await row(note.id);
    expect(after).toMatchObject({
      body: "ETA Monday.\nCustomer agreed.",
      author_id: cds.id,
      author_name: note.author_name,
      created_at: note.created_at,
    });
    expect(new Date(after.edited_at).getTime()).toBeGreaterThan(before - 60_000);
    const logged = await must(admin.from("audit_log").select("action, old_data, new_data").eq("row_id", note.id));
    expect(logged).toEqual([
      expect.objectContaining({
        action: "update",
        old_data: expect.objectContaining({ body: "ETA Friday." }),
        new_data: expect.objectContaining({ body: "ETA Monday.\nCustomer agreed." }),
      }),
    ]);
  });

  it("the same text changes nothing", async () => {
    const note = await addNote(cds, "Unchanged.");
    await must(edit(cds, note.id, " Unchanged. "));
    expect((await row(note.id)).edited_at).toBeNull();
  });

  it("refuses an empty or too long text", async () => {
    const note = await addNote(cds, "Keep me.");
    for (const body of ["", "  \n ", "x".repeat(2001)]) {
      const { error } = await edit(cds, note.id, body);
      expect(error?.code, JSON.stringify(body.slice(0, 5))).toBe("P0001");
    }
    expect((await row(note.id)).body).toBe("Keep me.");
  });

  it("another CDS user, a shop and anonymous callers cannot edit it", async () => {
    const note = await addNote(cds, "Mine.");
    expect((await edit(otherCds, note.id, "theirs")).error?.code).toBe("42501");
    expect((await edit(shop, note.id, "shop")).error?.code).toBe("42501");
    expect((await edit({ client: anon() }, note.id, "anon")).error).not.toBeNull();
    expect((await row(note.id)).body).toBe("Mine.");
  });

  it("a direct update is still refused, for the author too", async () => {
    const note = await addNote(cds, "Direct.");
    const { data } = await cds.client.from(TABLE).update({ body: "direct edit" }).eq("id", note.id).select();
    expect(data ?? []).toEqual([]);
    expect((await row(note.id)).body).toBe("Direct.");
  });

  it("a note the shop sees cannot be edited through the function", async () => {
    const shared = await must(cds.client.from("work_order_notes").insert({ work_order_id: wo, body: "Shop sees this." }).select().single());
    const { error } = await edit(cds, shared.id, "changed");
    expect(error?.code).toBe("P0002");
    expect((await must(admin.from("work_order_notes").select("body").eq("id", shared.id).single())).body).toBe("Shop sees this.");
  });
});
