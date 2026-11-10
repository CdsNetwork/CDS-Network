/**
 * Shop updates flag (20261111040000_shop_updates.sql).
 *
 * A shop's shared note, a file the shop uploads, or a component the shop marks failed or
 * condemned sets work_order_shop_activity.shop_activity_at; CDS opening the work order
 * (cds_mark_work_order_seen) sets cds_viewed_at, and is_new is true while the shop's activity
 * is newer. CDS's own notes and files never flag an order. Each failure is one
 * component_failures row (the dispatch@ email is keyed on it). Shops cannot read either table
 * nor clear the flag.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;

const LABEL = `UPDATES-${runId}`;

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

const activity = async (wo: string) =>
  (await must(admin.from("work_order_shop_activity").select("*").eq("work_order_id", wo).maybeSingle())) as {
    is_new: boolean;
    shop_activity: string | null;
    shop_activity_at: string | null;
    cds_viewed_at: string | null;
    cds_viewed_by: string | null;
  } | null;

const isNew = async (wo: string) => (await activity(wo))?.is_new ?? false;

const seen = (who: Login, wo: string) => who.client.rpc("cds_mark_work_order_seen", { p_work_order: wo });

const addFile = (wo: string, uploader: string) =>
  must(
    admin.from("attachments").insert({
      work_order_id: wo,
      category: "other",
      storage_path: `${wo}/${randomUUID()}-photo.png`,
      file_name: "photo.png",
      uploaded_by: uploader,
    }),
  );

async function component(wo: string): Promise<string> {
  const { data, error } = await shopLogin.client.rpc("shop_save_component", {
    p_work_order: wo,
    p_component: null,
    p_type: "DPF",
    p_manufacturer: null,
    p_part_number: null,
    p_serial_number: null,
    p_dp_before: null,
    p_dp_after: null,
    p_weight_before_g: null,
    p_weight_after_g: null,
    p_result: null,
    p_result_note: null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

const setResult = (wo: string, comp: string, result: string | null, note: string | null) =>
  shopLogin.client.rpc("shop_save_component", {
    p_work_order: wo,
    p_component: comp,
    p_type: "DPF",
    p_manufacturer: "Donaldson",
    p_part_number: "2871891",
    p_serial_number: "SN-4471",
    p_dp_before: null,
    p_dp_after: null,
    p_weight_before_g: null,
    p_weight_after_g: null,
    p_result: result,
    p_result_note: note,
  });

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `UA-${runId}`, display_name: `Shop Updates ${runId}` })).id;
  customer = (await insertOne("customers", { code: `UC-${runId}`, name: `Customer Updates ${runId}` })).id;
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

describe("New from shop", () => {
  it("a shop note flags the order and CDS opening it clears the flag", async () => {
    const wo = await workOrder("U-1");
    expect(await isNew(wo)).toBe(false);
    await must(shopLogin.client.from("work_order_notes").insert({ work_order_id: wo, body: "Failed, see photos" }));
    expect(await activity(wo)).toMatchObject({ is_new: true, shop_activity: "note" });

    await must(seen(cds, wo));
    const after = await activity(wo);
    expect(after).toMatchObject({ is_new: false, cds_viewed_by: cds.id });

    // A later shop note flags it again.
    await must(shopLogin.client.from("work_order_notes").insert({ work_order_id: wo, body: "More photos" }));
    expect(await isNew(wo)).toBe(true);
  });

  it("CDS's own notes and files never flag an order", async () => {
    const wo = await workOrder("U-2");
    await must(cds.client.from("work_order_notes").insert({ work_order_id: wo, body: "Called the customer" }));
    await addFile(wo, cds.id);
    expect(await isNew(wo)).toBe(false);
  });

  it("a file the shop uploads flags the order", async () => {
    const wo = await workOrder("U-3");
    await addFile(wo, shopLogin.id);
    expect(await activity(wo)).toMatchObject({ is_new: true, shop_activity: "file" });
  });

  it("a component marked failed flags the order and records one failure per change", async () => {
    const wo = await workOrder("U-4");
    const comp = await component(wo);
    expect(await isNew(wo)).toBe(false);

    await must(setResult(wo, comp, "failed", "Cracked substrate"));
    expect(await activity(wo)).toMatchObject({ is_new: true, shop_activity: "failed" });
    const failures = await must(admin.from("component_failures").select("*").eq("work_order_id", wo));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      component_id: comp,
      affiliate_id: shop,
      component_type: "DPF",
      result: "failed",
      result_note: "Cracked substrate",
      failed_by: shopLogin.id,
    });

    // Saving it again unchanged is no new failure; cleaned and failed again is.
    await must(setResult(wo, comp, "failed", "Cracked substrate, more photos"));
    expect(await must(admin.from("component_failures").select("id").eq("work_order_id", wo))).toHaveLength(1);
    await must(setResult(wo, comp, "cleaned", null));
    await must(setResult(wo, comp, "condemned", "Melted"));
    expect(await must(admin.from("component_failures").select("result").eq("work_order_id", wo).order("at"))).toEqual([
      { result: "failed" },
      { result: "condemned" },
    ]);
  });

  it("shops cannot see the view tracking or failures, nor clear the flag", async () => {
    const wo = await workOrder("U-5");
    await must(shopLogin.client.from("work_order_notes").insert({ work_order_id: wo, body: "Note" }));
    expect((await shopLogin.client.from("work_order_shop_activity").select("*")).data ?? []).toEqual([]);
    expect((await shopLogin.client.from("component_failures").select("*")).data ?? []).toEqual([]);

    const { error } = await seen(shopLogin, wo);
    expect(error?.code).toBe("42501");
    const { data: updated } = await shopLogin.client
      .from("work_order_shop_activity")
      .update({ cds_viewed_at: new Date().toISOString() })
      .eq("work_order_id", wo)
      .select();
    expect(updated ?? []).toEqual([]);
    expect(await isNew(wo)).toBe(true);

    const client = anon();
    expect((await client.from("work_order_shop_activity").select("*")).data ?? []).toEqual([]);
    expect((await client.rpc("cds_mark_work_order_seen", { p_work_order: wo })).error).not.toBeNull();
  });

  it("CDS reads the flag and cannot write it directly", async () => {
    const wo = await workOrder("U-6");
    await addFile(wo, shopLogin.id);
    const rows = await must(cds.client.from("work_order_shop_activity").select("work_order_id, is_new").eq("work_order_id", wo));
    expect(rows).toEqual([{ work_order_id: wo, is_new: true }]);
    const { data: updated } = await cds.client
      .from("work_order_shop_activity")
      .update({ shop_activity_at: null })
      .eq("work_order_id", wo)
      .select();
    expect(updated ?? []).toEqual([]);
  });
});
