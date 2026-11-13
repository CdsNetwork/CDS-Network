/**
 * QuickBooks tax and total on the work order (CDS, Sarah, 2026-11-13;
 * 20261113020000_qb_invoice_amounts.sql).
 *
 * cds_mark_invoiced also stores the sales tax and total QuickBooks calculated for the invoice
 * (work_order_internal.qb_tax_total, qb_total). The call with the three original arguments
 * still works and leaves them empty. Recording the same invoice again fills amounts that were
 * missing. The columns are on the CDS-only table, so a shop login reads nothing.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let shopId: string;
let customer: string;
let cds: Login;
let shop: Login;

const LABEL = `QBA-${runId}`;
let seq = 0;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(status: string): Promise<string> {
  seq += 1;
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shopId,
    status,
    unit_number: `U-${seq}`,
    requested_work: "Test cleaning",
    affiliate_invoice_ref: status === "completed" ? "INV-1" : null,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

const amounts = async (wo: string) =>
  must(admin.from("work_order_internal").select("qb_invoice_id, qb_tax_total, qb_total").eq("work_order_id", wo).single());

beforeAll(async () => {
  shopId = (await insertOne("affiliates", { short_code: `QBA-${runId}`, display_name: `Shop QBA ${runId}` })).id;
  customer = (await insertOne("customers", { code: `QBA-${runId}`, name: `Customer QBA ${runId}` })).id;
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().eq("id", customer));
  await must(admin.from("affiliates").delete().eq("id", shopId));
}, 120_000);

describe("cds_mark_invoiced with the QuickBooks amounts", () => {
  it("stores the tax and total QuickBooks calculated", async () => {
    const wo = await workOrder("completed");
    await must(
      cds.client.rpc("cds_mark_invoiced", {
        p_work_order: wo,
        p_qb_invoice_id: `QBA${runId}a`,
        p_qb_invoice_number: `N${runId}a`,
        p_qb_tax_total: 60,
        p_qb_total: 1060.5,
      }),
    );
    expect(await amounts(wo)).toEqual({ qb_invoice_id: `QBA${runId}a`, qb_tax_total: 60, qb_total: 1060.5 });
    const order = await must(admin.from("work_orders").select("status").eq("id", wo).single());
    expect(order.status).toBe("invoiced");
  });

  it("still accepts the three original arguments and leaves the amounts empty", async () => {
    const wo = await workOrder("completed");
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo, p_qb_invoice_id: `QBA${runId}b`, p_qb_invoice_number: null }));
    expect(await amounts(wo)).toEqual({ qb_invoice_id: `QBA${runId}b`, qb_tax_total: null, qb_total: null });
  });

  it("fills missing amounts when the same invoice is recorded again", async () => {
    const wo = await workOrder("in_process");
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo, p_qb_invoice_id: `QBA${runId}c`, p_qb_invoice_number: null }));
    await must(
      cds.client.rpc("cds_mark_invoiced", {
        p_work_order: wo,
        p_qb_invoice_id: `QBA${runId}c`,
        p_qb_invoice_number: null,
        p_qb_tax_total: 6,
        p_qb_total: 106,
      }),
    );
    expect(await amounts(wo)).toEqual({ qb_invoice_id: `QBA${runId}c`, qb_tax_total: 6, qb_total: 106 });
  });

  it("refuses negative amounts", async () => {
    const wo = await workOrder("completed");
    const { error } = await cds.client.rpc("cds_mark_invoiced", {
      p_work_order: wo,
      p_qb_invoice_id: `QBA${runId}d`,
      p_qb_invoice_number: null,
      p_qb_tax_total: -1,
      p_qb_total: 100,
    });
    expect(error).not.toBeNull();
    expect((await amounts(wo)).qb_invoice_id).toBeNull();
  });

  it("a shop login can neither record nor read the amounts", async () => {
    const wo = await workOrder("completed");
    const mark = await shop.client.rpc("cds_mark_invoiced", {
      p_work_order: wo,
      p_qb_invoice_id: `QBA${runId}e`,
      p_qb_invoice_number: null,
      p_qb_tax_total: 1,
      p_qb_total: 2,
    });
    expect(mark.error).not.toBeNull();
    await must(admin.from("work_order_internal").update({ qb_tax_total: 6, qb_total: 106 }).eq("work_order_id", wo));
    const read = await shop.client.from("work_order_internal").select("qb_tax_total, qb_total").eq("work_order_id", wo);
    expect(read.data ?? []).toHaveLength(0);
  });
});
