/**
 * Unit # and customer location after dispatch (Sarah, CDS, 2026-11-24): CDS changes them on an
 * order the shop already has (updateWorkOrderUnit / updateWorkOrderLocation make these same
 * updates as the CDS login). No database change was needed; this checks the guards they rely on:
 *
 *  - CDS can change unit_number, location_id, location_label and site_address after dispatch;
 *    the shop reads the new values on its job and cannot change them itself.
 *  - While the QuickBooks invoice is being created (private.invoice_inputs_locked) both are
 *    refused; once the order has its QuickBooks invoice the location is refused
 *    (private.order_locked_when_invoiced).
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `ULAD-${runId}`;
let shop: string;
let customer: string;
let locA: string;
let locB: string;
let cds: Login;
let shopLogin: Login;

async function workOrder(): Promise<string> {
  const wo = (await must(
    admin
      .from("work_orders")
      .insert({
        customer_id: customer,
        location_id: null,
        location_label: LABEL,
        fulfillment: "shipping",
        affiliate_id: shop,
        status: "in_process",
        request_type: "service",
        unit_number: "U-OLD",
        requested_work: "Test cleaning",
      })
      .select("id")
      .single(),
  )) as { id: string };
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

const location = (code: string) =>
  must(
    admin
      .from("customer_locations")
      .insert({ customer_id: customer, code, name: `Yard ${code}`, address_raw: `${code} Example Rd, Springfield, CA 90000`, region: "CA" })
      .select("id")
      .single(),
  ).then((r) => (r as { id: string }).id);

beforeAll(async () => {
  shop = ((await must(admin.from("affiliates").insert({ short_code: LABEL, display_name: `Unit Location Shop ${runId}` }).select().single())) as { id: string }).id;
  customer = ((await must(admin.from("customers").insert({ code: LABEL, name: `Unit Location Customer ${runId}` }).select().single())) as { id: string }).id;
  locA = await location(`${LABEL}-A`);
  locB = await location(`${LABEL}-B`);
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("customer_id", customer));
  await deleteLogins();
  await must(admin.from("customer_locations").delete().eq("customer_id", customer));
  await must(admin.from("customers").delete().eq("code", LABEL));
  await must(admin.from("affiliates").delete().eq("short_code", LABEL));
}, 120_000);

describe("unit and location after dispatch", () => {
  it("CDS sets them on the shop's job; the shop reads them and cannot change them", async () => {
    const wo = await workOrder();
    await must(
      cds.client
        .from("work_orders")
        .update({ unit_number: "U-NEW", location_id: locA, location_label: `${LABEL}-A Yard`, site_address: "A Example Rd" })
        .eq("id", wo)
        .select("id")
        .single(),
    );
    await must(cds.client.from("work_order_internal").update({ routing_notes: "Dock 3" }).eq("work_order_id", wo).select("work_order_id").single());

    const seen = await must(shopLogin.client.from("work_orders").select("unit_number, location_label, site_address, status").eq("id", wo).single());
    expect(seen).toEqual({ unit_number: "U-NEW", location_label: `${LABEL}-A Yard`, site_address: "A Example Rd", status: "in_process" });

    await shopLogin.client.from("work_orders").update({ unit_number: "U-SHOP", location_id: locB }).eq("id", wo);
    const row = await must(admin.from("work_orders").select("unit_number, location_id").eq("id", wo).single());
    expect(row).toEqual({ unit_number: "U-NEW", location_id: locA });
  });

  it("refused while the QuickBooks invoice is being created", async () => {
    const wo = await workOrder();
    await must(
      admin.from("qbo_invoice_claims").insert({ work_order_id: wo, state: "sending", claim_id: randomUUID(), claimed_at: new Date().toISOString() }),
    );
    const unit = await cds.client.from("work_orders").update({ unit_number: "U-2" }).eq("id", wo).select("id");
    expect(unit.error?.message).toMatch(/being created in QuickBooks/);
    const loc = await cds.client.from("work_orders").update({ location_id: locB }).eq("id", wo).select("id");
    expect(loc.error?.message).toMatch(/being created in QuickBooks/);
    const row = await must(admin.from("work_orders").select("unit_number, location_id").eq("id", wo).single());
    expect(row).toEqual({ unit_number: "U-OLD", location_id: null });
  });

  it("the location is refused once the order has its QuickBooks invoice", async () => {
    const wo = await workOrder();
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo, p_qb_invoice_id: `ULAD${runId}`, p_qb_invoice_number: null }));
    const loc = await cds.client.from("work_orders").update({ location_id: locB }).eq("id", wo).select("id");
    expect(loc.error?.message).toMatch(/cannot change after the order is invoiced/);
    const row = await must(admin.from("work_orders").select("location_id").eq("id", wo).single());
    expect(row).toEqual({ location_id: null });
  });
});
