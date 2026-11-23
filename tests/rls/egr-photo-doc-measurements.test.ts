/**
 * Sarah, CDS, 2026-11-17 (20261119040000_egr_no_photo_doc_optional.sql and
 * 20261119030000_pickup_window_tomorrow.sql):
 *  - shop_complete_work_order no longer asks for a photo of a condemned EGR cooler; other
 *    condemned components still need one.
 *  - A DOC completes without pressure or weight; a cleaned DPF still needs them.
 *  - A shop can accept a pickup job with the pickup window "tomorrow".
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pacificToday } from "@/lib/dates";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shop: string;
let customer: string;
let shopLogin: Login;

const LABEL = `EGRDOC-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

type Part = { type: "DPF" | "DOC" | "SCR" | "EGR"; result: string; photo?: boolean; measured?: boolean };

/** An in-process job with the given components. */
async function job(unit: string, parts: Part[], fulfillment = "shipping", status = "in_process"): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment,
    affiliate_id: shop,
    status,
    unit_number: unit,
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  let seq = 0;
  for (const p of parts) {
    seq += 1;
    const c = await insertOne("work_order_components", {
      work_order_id: wo.id,
      affiliate_id: shop,
      seq,
      component_type: p.type,
      manufacturer: "Test",
      part_number: `PN-${runId}`,
      serial_number: `SN-${runId}-${unit}-${seq}`,
      result: p.result,
      result_note: p.result === "condemned" ? "Cracked" : null,
      ...(p.measured ? { dp_before: 2.5, dp_after: 0.8, weight_before_g: 15000, weight_after_g: 14500 } : {}),
    });
    if (p.photo) {
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
  }
  return wo.id;
}

const complete = (wo: string) =>
  shopLogin.client.rpc("shop_complete_work_order", { p_work_order: wo, p_invoice_ref: `INV-${runId}-${wo.slice(0, 8)}` });

const statusOf = async (wo: string) => (await must(admin.from("work_orders").select("status, pickup_window").eq("id", wo).single())) as { status: string; pickup_window: string | null };

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `ED-${runId}`, display_name: `EGR DOC Shop ${runId}` })).id;
  customer = (await insertOne("customers", { code: `EC-${runId}`, name: `EGR DOC Customer ${runId}` })).id;
  shopLogin = await createLogin("shop", shop);
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

describe("condemned EGR cooler", () => {
  it("completes without a photo", async () => {
    const wo = await job("E-1", [{ type: "EGR", result: "condemned" }]);
    await must(complete(wo));
    expect((await statusOf(wo)).status).toBe("completed");
  });

  it("a condemned DOC or SCR still needs its photo", async () => {
    for (const type of ["DOC", "SCR"] as const) {
      const wo = await job(`E-2-${type}`, [{ type, result: "condemned" }]);
      const { error } = await complete(wo);
      expect(error?.message, type).toMatch(/add a photo for a condemned part/);
    }
  });
});

describe("DOC measurements", () => {
  it("a cleaned DOC without pressure or weight completes", async () => {
    const wo = await job("D-1", [{ type: "DOC", result: "cleaned" }]);
    await must(complete(wo));
    expect((await statusOf(wo)).status).toBe("completed");
  });

  it("a cleaned DPF without them is still refused, and completes once measured", async () => {
    const bad = await job("D-2", [{ type: "DPF", result: "cleaned" }]);
    const { error } = await complete(bad);
    expect(error?.message).toMatch(/pressure before and after, and weight before and after/);
    const ok = await job("D-3", [{ type: "DPF", result: "cleaned", measured: true }, { type: "DOC", result: "cleaned" }]);
    await must(complete(ok));
    expect((await statusOf(ok)).status).toBe("completed");
  });
});

describe("Tomorrow pickup window", () => {
  // Since 20261119130000_shop_pickup_date.sql (Clyde, 2026-11-18) the shop chooses the pickup
  // day: "tomorrow" is tomorrow's date with a window (tests/rls/shop-pickup-date.test.ts).
  it("a shop accepts a pickup job for tomorrow", async () => {
    const wo = await job("T-1", [], "pickup", "awaiting_acceptance");
    const tomorrow = pacificToday(new Date(Date.now() + 86_400_000));
    await must(
      shopLogin.client.rpc("shop_accept_work_order", { p_work_order: wo, p_pickup_window: "coordinate", p_pickup_date: tomorrow }),
    );
    expect(await statusOf(wo)).toEqual({ status: "accepted", pickup_window: "coordinate" });
  });
});
