/**
 * Duplicate shop bill numbers (Sarah, CDS, 2026-11-23; 20261123010000_duplicate_bill_number.sql):
 * public.shop_complete_work_order refuses an invoice or reference number that another work
 * order of the same shop (not cancelled) already has, ignoring case and spaces. Another shop may
 * use the same number. Works without QuickBooks (the QuickBooks side is in the server action,
 * tests/unit/duplicate-bill-number.test.ts).
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `DUPBILL-${runId}`;
let shop: string;
let otherShop: string;
let customer: string;
let shopLogin: Login;
let otherLogin: Login;

async function workOrder(affiliate: string, status = "in_process"): Promise<{ id: string; wo_number: number }> {
  const wo = (await must(
    admin
      .from("work_orders")
      .insert({
        customer_id: customer,
        location_label: LABEL,
        fulfillment: "shipping",
        affiliate_id: affiliate,
        status,
        request_type: "parts_only",
        unit_number: "DB-1",
        requested_work: "Filter sale",
      })
      .select("id, wo_number")
      .single(),
  )) as { id: string; wo_number: number };
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo;
}

const complete = (login: Login, wo: string, ref: string) =>
  login.client.rpc("shop_complete_work_order", { p_work_order: wo, p_invoice_ref: ref });

beforeAll(async () => {
  shop = ((await must(admin.from("affiliates").insert({ short_code: `DB-${runId}`, display_name: `Dup Bill Shop ${runId}` }).select().single())) as { id: string }).id;
  otherShop = ((await must(admin.from("affiliates").insert({ short_code: `DB2-${runId}`, display_name: `Dup Bill Other ${runId}` }).select().single())) as { id: string }).id;
  customer = ((await must(admin.from("customers").insert({ code: `DB-${runId}`, name: `Dup Bill Customer ${runId}` }).select().single())) as { id: string }).id;
  shopLogin = await createLogin("shop", shop);
  otherLogin = await createLogin("shop", otherShop);
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().eq("code", `DB-${runId}`));
  await must(admin.from("affiliates").delete().in("short_code", [`DB-${runId}`, `DB2-${runId}`]));
}, 120_000);

describe("shop_complete_work_order and a bill number already used", () => {
  it("refuses a number another order of the same shop has, in any case and with spaces", async () => {
    const first = await workOrder(shop);
    await must(complete(shopLogin, first.id, "INV-5001"));

    const second = await workOrder(shop);
    const { error } = await complete(shopLogin, second.id, "  inv-5001 ");
    expect(error?.message).toBe(`Bill number inv-5001 is already used on WO-${first.wo_number} for your shop. Check the number and try again.`);
    const after = await must(admin.from("work_orders").select("status, affiliate_invoice_ref").eq("id", second.id).single());
    expect(after).toEqual({ status: "in_process", affiliate_invoice_ref: null });

    await must(complete(shopLogin, second.id, "INV-5002"));
  });

  it("lets another shop use the same number", async () => {
    const mine = await workOrder(shop);
    await must(complete(shopLogin, mine.id, "INV-6001"));
    const theirs = await workOrder(otherShop);
    await must(complete(otherLogin, theirs.id, "INV-6001"));
  });

  it("does not count a cancelled order", async () => {
    const cancelled = await workOrder(shop, "cancelled");
    await must(admin.from("work_orders").update({ affiliate_invoice_ref: "INV-7001" }).eq("id", cancelled.id));
    const wo = await workOrder(shop);
    await must(complete(shopLogin, wo.id, "INV-7001"));
  });
});
