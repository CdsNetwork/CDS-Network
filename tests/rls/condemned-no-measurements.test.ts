/**
 * Condemned filters are not measured (CDS, 2026-11-12;
 * 20261112010000_condemned_no_measurements.sql).
 *
 * shop_complete_work_order no longer asks for pressure and weight on a DPF or DOC the shop
 * marked condemned. A cleaned or failed one without them is still refused, and a condemned
 * one still needs its photo.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shop: string;
let customer: string;
let shopLogin: Login;

const LABEL = `CONDEMNED-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

/** An in-process job with one DPF that has no measurements, with the given result. */
async function jobWithDpf(unit: string, result: "cleaned" | "failed" | "condemned", photo: boolean): Promise<string> {
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
  const c = await insertOne("work_order_components", {
    work_order_id: wo.id,
    affiliate_id: shop,
    seq: 1,
    component_type: "DPF",
    manufacturer: "Test",
    part_number: `PN-${runId}`,
    serial_number: `SN-${runId}-${unit}`,
    result,
    result_note: result === "cleaned" ? null : "Cracked substrate",
  });
  if (photo) {
    await must(
      admin.from("attachments").insert({
        work_order_id: wo.id,
        component_id: c.id,
        category: "condition_damage",
        storage_path: `${wo.id}/${randomUUID()}-photo.png`,
        file_name: "photo.png",
      }),
    );
  }
  return wo.id;
}

const complete = (wo: string) =>
  shopLogin.client.rpc("shop_complete_work_order", { p_work_order: wo, p_invoice_ref: `INV-${runId}` });

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `CN-${runId}`, display_name: `Condemned Shop ${runId}` })).id;
  customer = (await insertOne("customers", { code: `CC-${runId}`, name: `Condemned Customer ${runId}` })).id;
  shopLogin = await createLogin("shop", shop);
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  const wos = (await must(admin.from("work_orders").select("id").eq("location_label", LABEL))) as { id: string }[];
  if (wos.length) {
    await must(admin.from("attachments").delete().in("work_order_id", wos.map((w) => w.id)));
  }
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
}, 120_000);

describe("completing a job with a filter that has no measurements", () => {
  it("a condemned DPF without pressure or weight completes", async () => {
    const wo = await jobWithDpf("C-1", "condemned", true);
    await must(complete(wo));
    const after = await must(admin.from("work_orders").select("status").eq("id", wo).single());
    expect(after.status).toBe("completed");
  });

  it("a failed DPF without pressure or weight is still refused", async () => {
    const wo = await jobWithDpf("C-2", "failed", true);
    const { error } = await complete(wo);
    expect(error?.message).toMatch(/pressure before and after, and weight before and after/);
  });

  it("a cleaned DPF without pressure or weight is still refused", async () => {
    const wo = await jobWithDpf("C-3", "cleaned", false);
    const { error } = await complete(wo);
    expect(error?.message).toMatch(/pressure before and after, and weight before and after/);
  });

  it("a condemned DPF still needs its photo", async () => {
    const wo = await jobWithDpf("C-4", "condemned", false);
    const { error } = await complete(wo);
    expect(error?.message).toMatch(/add a photo for a failed or condemned part/);
  });
});
