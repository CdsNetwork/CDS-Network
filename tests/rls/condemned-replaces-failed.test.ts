/**
 * "Condemned" replaces "Failed" (Sarah, CDS, 2026-11-12;
 * 20261112050000_condemned_replaces_failed.sql).
 *
 * A component result can no longer be set to 'failed', by the shop or by CDS. An EGR cooler is
 * Pass or Condemned. Rows that said 'failed' were changed to 'condemned' by the migration (the
 * probe row below was inserted on the test project before the migration was pushed), and a
 * job with a condemned EGR still completes.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shop: string;
let customer: string;
let shopLogin: Login;
let cds: Login;

const LABEL = `CRF-${runId}`;
/**
 * The work order a probe script created on the test project before the migration ran. Only
 * the probe test removes it, after checking it.
 */
const PROBE_LABEL = "CRF-MIGRATION-PROBE";

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function job(unit: string): Promise<string> {
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

const save = (wo: string, comp: string | null, type: string, result: string | null, note: string | null) =>
  shopLogin.client.rpc("shop_save_component", {
    p_work_order: wo,
    p_component: comp,
    p_type: type,
    p_manufacturer: "Test",
    p_part_number: `PN-${runId}`,
    p_serial_number: `SN-${runId}`,
    p_dp_before: null,
    p_dp_after: null,
    p_weight_before_g: null,
    p_weight_after_g: null,
    p_result: result,
    p_result_note: note,
  });

async function newComponent(wo: string, type: string): Promise<string> {
  await must(save(wo, null, type, null, null));
  const rows = await must(admin.from("work_order_components").select("id").eq("work_order_id", wo).eq("component_type", type));
  return rows[0].id;
}

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `CRF-${runId}`, display_name: `Shop CRF ${runId}` })).id;
  customer = (await insertOne("customers", { code: `CRF-${runId}`, name: `Customer CRF ${runId}` })).id;
  shopLogin = await createLogin("shop", shop);
  cds = await createLogin("cds", null);
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  const wos = (await must(admin.from("work_orders").select("id").eq("location_label", LABEL))) as { id: string }[];
  if (wos.length) await must(admin.from("attachments").delete().in("work_order_id", wos.map((w) => w.id)));
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
}, 120_000);

describe("'failed' cannot be set any more", () => {
  it("the shop cannot mark a filter or an EGR failed", async () => {
    const wo = await job("F-1");
    for (const type of ["DPF", "EGR"]) {
      const comp = await newComponent(wo, type);
      const { error } = await save(wo, comp, type, "failed", "Cracked");
      expect(error, type).not.toBeNull();
      const row = await must(admin.from("work_order_components").select("result").eq("id", comp).single());
      expect(row.result, type).toBeNull();
    }
  });

  it("CDS cannot write it either", async () => {
    const wo = await job("F-2");
    const comp = await newComponent(wo, "DPF");
    const { error } = await cds.client.from("work_order_components").update({ result: "failed", result_note: "x" }).eq("id", comp);
    expect(error).not.toBeNull();
  });

  it("no component or recorded failure says 'failed' any more", async () => {
    const comps = await admin.from("work_order_components").select("id", { count: "exact", head: true }).eq("result", "failed");
    expect(comps.count).toBe(0);
    const failures = await admin.from("component_failures").select("id", { count: "exact", head: true }).eq("result", "failed");
    expect(failures.count).toBe(0);
  });

  it("the probe row that said 'failed' before the migration now says 'condemned'", async () => {
    const probe = await must(admin.from("work_orders").select("id").eq("location_label", PROBE_LABEL));
    expect(probe, "run the probe script before pushing the migration").toHaveLength(1);
    const comp = await must(admin.from("work_order_components").select("result, result_note").eq("work_order_id", probe[0].id).single());
    expect(comp).toEqual({ result: "condemned", result_note: "Probe: cracked substrate" });
    const failure = await must(admin.from("component_failures").select("result").eq("work_order_id", probe[0].id));
    expect(failure).toEqual([{ result: "condemned" }]);
    // Removed only once checked, so a run before the migration leaves it in place.
    await must(admin.from("work_orders").delete().eq("location_label", PROBE_LABEL));
    await must(admin.from("customers").delete().eq("code", "CRF-PROBE"));
    await must(admin.from("affiliates").delete().eq("short_code", "CRF-PROBE"));
  });
});

describe("a condemned EGR", () => {
  it("can be set with a reason, is recorded as a failure and flags the order", async () => {
    const wo = await job("E-1");
    const comp = await newComponent(wo, "EGR");
    const noNote = await save(wo, comp, "EGR", "condemned", null);
    expect(noNote.error).not.toBeNull();
    await must(save(wo, comp, "EGR", "condemned", "Leaking core"));
    const failures = await must(admin.from("component_failures").select("result, component_type").eq("work_order_id", wo));
    expect(failures).toEqual([{ result: "condemned", component_type: "EGR" }]);
    const activity = await must(admin.from("work_order_shop_activity").select("is_new").eq("work_order_id", wo).single());
    expect(activity.is_new).toBe(true);
  });

  it("completes the job once it has its photo", async () => {
    const wo = await job("E-2");
    const comp = await newComponent(wo, "EGR");
    await must(save(wo, comp, "EGR", "condemned", "Leaking core"));
    const complete = () => shopLogin.client.rpc("shop_complete_work_order", { p_work_order: wo, p_invoice_ref: `INV-${runId}` });
    const noPhoto = await complete();
    expect(noPhoto.error?.message).toMatch(/add a photo for a condemned part/);
    await must(
      admin.from("attachments").insert({
        work_order_id: wo,
        component_id: comp,
        category: "condition_damage",
        storage_path: `${wo}/${randomUUID()}-photo.png`,
        file_name: "photo.png",
      }),
    );
    await must(complete());
    const after = await must(admin.from("work_orders").select("status").eq("id", wo).single());
    expect(after.status).toBe("completed");
  });
});
