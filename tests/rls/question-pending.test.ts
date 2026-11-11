/**
 * "Question Pending" (20261111070000_question_pending.sql).
 *
 * CDS switches the flag on (with an optional note) and off through cds_set_question_pending;
 * each change writes one audit_log row and never changes the order's status. The flag lives
 * in work_order_questions, which shops and anon cannot read, and nobody writes it directly.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;

const LABEL = `QUESTION-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(unit: string): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shop,
    status: "in_process",
    unit_number: unit,
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

type Question = {
  question_pending: boolean;
  note: string | null;
  set_by: string | null;
  set_at: string | null;
  cleared_by: string | null;
  cleared_at: string | null;
};

const question = async (wo: string) =>
  (await must(admin.from("work_order_questions").select("*").eq("work_order_id", wo).maybeSingle())) as Question | null;

const audits = async (wo: string) =>
  (await must(
    admin.from("audit_log").select("action, actor_id, old_data, new_data").eq("table_name", "work_order_questions").eq("row_id", wo).order("id"),
  )) as { action: string; actor_id: string; old_data: Question | null; new_data: Question }[];

const status = async (wo: string) =>
  ((await must(admin.from("work_orders").select("status").eq("id", wo).single())) as { status: string }).status;

const setQuestion = (who: Login, wo: string, pending: boolean, note: string | null = null) =>
  who.client.rpc("cds_set_question_pending", { p_work_order: wo, p_pending: pending, p_note: note });

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `QA-${runId}`, display_name: `Question Shop ${runId}` })).id;
  customer = (await insertOne("customers", { code: `QC-${runId}`, name: `Question Customer ${runId}` })).id;
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
}, 120_000);

describe("Question Pending", () => {
  it("CDS switches it on and off, with who and when, an audit row each time, and the status unchanged", async () => {
    const wo = await workOrder("Q-1");
    expect(await question(wo)).toBeNull();

    await must(setQuestion(cds, wo, true, "  Ryder asks if the DPF can be reused  "));
    const on = await question(wo);
    expect(on).toMatchObject({ question_pending: true, note: "Ryder asks if the DPF can be reused", set_by: cds.id });
    expect(on?.set_at).not.toBeNull();
    expect(await status(wo)).toBe("in_process");

    // Asking again with a new note only updates the note; the same call twice writes nothing.
    await must(setQuestion(cds, wo, true, "Ryder wants photos too"));
    await must(setQuestion(cds, wo, true, "Ryder wants photos too"));
    expect(await question(wo)).toMatchObject({ question_pending: true, note: "Ryder wants photos too", set_at: on?.set_at });

    await must(setQuestion(cds, wo, false));
    await must(setQuestion(cds, wo, false));
    const off = await question(wo);
    expect(off).toMatchObject({ question_pending: false, note: null, cleared_by: cds.id });
    expect(await status(wo)).toBe("in_process");

    const log = await audits(wo);
    expect(log.map((a) => a.action)).toEqual(["insert", "update", "update"]);
    expect(log.every((a) => a.actor_id === cds.id)).toBe(true);
    expect(log[0].new_data).toMatchObject({ question_pending: true });
    expect(log[2].old_data).toMatchObject({ question_pending: true, note: "Ryder wants photos too" });
    expect(log[2].new_data).toMatchObject({ question_pending: false });
  });

  it("CDS reads the flag for the list filter and cannot write it directly", async () => {
    const wo = await workOrder("Q-2");
    await must(setQuestion(cds, wo, true));
    const rows = await must(cds.client.from("work_order_questions").select("work_order_id").eq("question_pending", true).eq("work_order_id", wo));
    expect(rows).toEqual([{ work_order_id: wo }]);

    const { data: updated } = await cds.client.from("work_order_questions").update({ question_pending: false }).eq("work_order_id", wo).select();
    expect(updated ?? []).toEqual([]);
    const { error: insertError } = await cds.client.from("work_order_questions").insert({ work_order_id: await workOrder("Q-3"), question_pending: true });
    expect(insertError).not.toBeNull();
    expect((await question(wo))?.question_pending).toBe(true);
  });

  it("a shop cannot see, set or clear it, and cannot read it through its work order", async () => {
    const wo = await workOrder("Q-4");
    await must(setQuestion(cds, wo, true, "Secret CDS question"));

    expect((await shopLogin.client.from("work_order_questions").select("*")).data ?? []).toEqual([]);
    // The shop can read its own work order, but the flag is not on it.
    const own = await must(shopLogin.client.from("work_orders").select("*").eq("id", wo));
    expect(own).toHaveLength(1);
    expect(Object.keys((own as Record<string, unknown>[])[0]).some((k) => k.includes("question"))).toBe(false);
    const embedded = await shopLogin.client.from("work_orders").select("id, work_order_questions(question_pending)").eq("id", wo);
    if (!embedded.error) {
      expect((embedded.data as { work_order_questions: unknown }[])[0].work_order_questions ?? null).toEqual(null);
    }

    const clear = await setQuestion(shopLogin, wo, false);
    expect(clear.error?.code).toBe("42501");
    const set = await setQuestion(shopLogin, await workOrder("Q-5"), true);
    expect(set.error?.code).toBe("42501");
    const { data: updated } = await shopLogin.client.from("work_order_questions").update({ question_pending: false }).eq("work_order_id", wo).select();
    expect(updated ?? []).toEqual([]);
    const { error: insertError } = await shopLogin.client.from("work_order_questions").insert({ work_order_id: wo, question_pending: false });
    expect(insertError).not.toBeNull();
    expect(await question(wo)).toMatchObject({ question_pending: true, note: "Secret CDS question" });

    const client = anon();
    expect((await client.from("work_order_questions").select("*")).data ?? []).toEqual([]);
    expect((await client.rpc("cds_set_question_pending", { p_work_order: wo, p_pending: false, p_note: null })).error).not.toBeNull();
  });

  it("refuses an unknown work order and a note that is too long", async () => {
    const missing = await setQuestion(cds, "00000000-0000-0000-0000-000000000000", true);
    expect(missing.error?.code).toBe("P0002");
    const wo = await workOrder("Q-6");
    const long = await setQuestion(cds, wo, true, "x".repeat(501));
    expect(long.error?.code).toBe("P0001");
    expect(await question(wo)).toBeNull();
  });

  it("goes with the work order when it is deleted", async () => {
    const wo = await workOrder("Q-7");
    await must(setQuestion(cds, wo, true));
    await must(admin.from("work_orders").delete().eq("id", wo));
    expect(await question(wo)).toBeNull();
  });
});
