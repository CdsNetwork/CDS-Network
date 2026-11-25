/**
 * The CDS work order page reads work_order_internal with WO_INTERNAL_COLUMNS, embedding the
 * approver's profile. 20261123100000_shop_bill_approval.sql added a second foreign key to
 * public.profiles (shop_bill_approved_by), which made a bare profiles(...) embed ambiguous:
 * the read failed, the page treated the internal row as missing and lost the shop shipping
 * credit checkbox, the QuickBooks invoice id, tax and the approver (reported by CDS,
 * 2026-11-25). The read must succeed as a CDS user and return the approver's name, also when
 * the shop's bill has been approved by someone else.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WO_INTERNAL_COLUMNS } from "@/components/cds-wo/work-order-internal";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `WOI-${runId}`;
let shopId: string;
let customer: string;
let approver: Login;
let billApprover: Login;
let cds: Login;
let wo: string;

async function insertOne(table: string, row: Record<string, unknown>): Promise<{ id: string }> {
  return must(admin.from(table).insert(row).select().single()) as Promise<{ id: string }>;
}

beforeAll(async () => {
  shopId = (await insertOne("affiliates", { short_code: `WOI-${runId}`, display_name: `Shop Internal ${runId}` })).id;
  customer = (await insertOne("customers", { code: `WOIC-${runId}`, name: `Customer Internal ${runId}` })).id;
  approver = await createLogin("cds", null);
  billApprover = await createLogin("cds", null);
  cds = await createLogin("cds", null);
  wo = (
    await insertOne("work_orders", {
      customer_id: customer,
      location_label: LABEL,
      fulfillment: "unspecified",
      affiliate_id: shopId,
      status: "completed",
      completed_at: new Date().toISOString(),
      affiliate_invoice_ref: "INV-1",
      unit_number: "A1",
      requested_work: "Test cleaning",
    })
  ).id;
  await must(
    admin.from("work_order_internal").insert({
      work_order_id: wo,
      approved_at: new Date().toISOString(),
      approved_by: approver.id,
      approved_by_name: "Approver at the time",
      shop_shipping_credit: true,
      routing_notes: "Route note",
    }),
  );
  await must(admin.from("profiles").update({ full_name: `Order Approver ${runId}` }).eq("id", approver.id));
  // The shop's bill is approved by a different CDS user than the order.
  await must(billApprover.client.rpc("cds_approve_shop_bill", { p_work_order: wo }));
  const bill = await must(admin.from("work_order_internal").select("shop_bill_approved_by").eq("work_order_id", wo).single());
  if (bill.shop_bill_approved_by !== billApprover.id) throw new Error("shop bill approval fixture not set");
}, 120_000);

afterAll(async () => {
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().eq("id", shopId);
  await admin.from("audit_log").delete().in("row_id", [shopId, customer, wo]);
}, 120_000);

describe("work order page internal read", () => {
  it("a CDS user reads the internal row with the order approver's name", async () => {
    const { data, error } = await cds.client.from("work_order_internal").select(WO_INTERNAL_COLUMNS).eq("work_order_id", wo).maybeSingle();
    expect(error).toBeNull();
    const row = data as unknown as {
      shop_shipping_credit: boolean;
      routing_notes: string | null;
      approved_by: string | null;
      profiles: { full_name: string } | { full_name: string }[] | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.shop_shipping_credit).toBe(true);
    expect(row?.routing_notes).toBe("Route note");
    expect(row?.approved_by).toBe(approver.id);
    const profile = Array.isArray(row?.profiles) ? row?.profiles[0] : row?.profiles;
    expect(profile?.full_name).toBe(`Order Approver ${runId}`);
  });
});
