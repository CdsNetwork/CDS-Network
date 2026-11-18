/**
 * Request type after the shop accepted (Sarah, CDS, 2026-11-18): a filter failed and a part is
 * sold instead, so CDS switches the order from Service to Parts Only (updateWorkOrderRequestType,
 * the same update a CDS login makes here). The shop then reads the order as parts only, and
 * completes it without components or measurements (20261119090000_parts_only_no_measurements.sql).
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `REQTYPE-${runId}`;
let shop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;

async function workOrder(status: string): Promise<string> {
  const wo = (await must(
    admin
      .from("work_orders")
      .insert({
        customer_id: customer,
        location_label: LABEL,
        fulfillment: "shipping",
        affiliate_id: shop,
        status,
        request_type: "service",
        unit_number: `RT-${status}`,
        requested_work: "Test cleaning",
      })
      .select("id")
      .single(),
  )) as { id: string };
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

beforeAll(async () => {
  shop = ((await must(admin.from("affiliates").insert({ short_code: `RT-${runId}`, display_name: `Request Type Shop ${runId}` }).select().single())) as { id: string }).id;
  customer = ((await must(admin.from("customers").insert({ code: `RT-${runId}`, name: `Request Type Customer ${runId}` }).select().single())) as { id: string }).id;
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().eq("code", `RT-${runId}`));
  await must(admin.from("affiliates").delete().eq("short_code", `RT-${runId}`));
}, 120_000);

describe("CDS switches an accepted service order to parts only", () => {
  it("the shop then completes it without components or measurements", async () => {
    const wo = await workOrder("in_process");
    // Before: a service order needs a component.
    const { error: before } = await shopLogin.client.rpc("shop_complete_work_order", { p_work_order: wo, p_invoice_ref: "INV-RT1" });
    expect(before?.message).toMatch(/Add at least one component/);

    await must(cds.client.from("work_orders").update({ request_type: "parts_only" }).eq("id", wo).select("id").single());
    await must(
      cds.client.from("work_order_events").insert({
        work_order_id: wo,
        actor_id: cds.id,
        event_type: "edit",
        message: "Request type changed by CDS: Service / Cleaning to Parts Only",
        shop_visible: false,
      }),
    );

    const seen = await must(shopLogin.client.from("work_orders").select("request_type, status").eq("id", wo).single());
    expect(seen).toEqual({ request_type: "parts_only", status: "in_process" });
    await must(shopLogin.client.rpc("shop_complete_work_order", { p_work_order: wo, p_invoice_ref: "INV-RT1" }));
    const after = await must(admin.from("work_orders").select("status, affiliate_invoice_ref").eq("id", wo).single());
    expect(after).toEqual({ status: "completed", affiliate_invoice_ref: "INV-RT1" });
  });

  it("a shop cannot change the request type itself", async () => {
    const wo = await workOrder("accepted");
    await shopLogin.client.from("work_orders").update({ request_type: "parts_only" }).eq("id", wo);
    const row = await must(admin.from("work_orders").select("request_type").eq("id", wo).single());
    expect(row).toEqual({ request_type: "service" });
  });
});
