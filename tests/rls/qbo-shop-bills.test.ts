/**
 * The shop's bill in QuickBooks (20261118010000_qbo_shop_bills.sql). The bill rows and the
 * vendor links are CDS only: a shop and an anonymous caller read nothing and write nothing.
 * Only the server (service role) can claim and finish a bill: not a shop, not a CDS login
 * directly. One claim per order, also for two claims at the same moment; never a second
 * bill once one is recorded; a cancelled, unfinished or in-house order is refused; a
 * QuickBooks refusal moves to the next request id, an unclear failure keeps it.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 * Nothing here calls QuickBooks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `BILL-${runId}`;
let shopId: string;
let customer: string;
let cds: Login;
let shop: Login;

async function order(over: Record<string, unknown> = {}): Promise<string> {
  const wo = await must(
    admin
      .from("work_orders")
      .insert({
        customer_id: customer,
        location_label: LABEL,
        fulfillment: "shipping",
        affiliate_id: shopId,
        status: "completed",
        completed_at: new Date().toISOString(),
        affiliate_invoice_ref: "INV-1",
        unit_number: "B1",
        requested_work: "Test cleaning",
        ...over,
      })
      .select()
      .single(),
  );
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id as string;
}

const claim = (wo: string) => admin.rpc("qbo_claim_shop_bill", { p_work_order: wo });
const finish = (wo: string, claimId: string | null, outcome: string, extra: Record<string, unknown> = {}) =>
  admin.rpc("qbo_finish_shop_bill", { p_work_order: wo, p_claim: claimId, p_outcome: outcome, ...extra });

beforeAll(async () => {
  shopId = (await must(admin.from("affiliates").insert({ short_code: `BIL-${runId}`, display_name: `Shop Bill ${runId}` }).select().single())).id;
  customer = (await must(admin.from("customers").insert({ code: `BIC-${runId}`, name: `Customer Bill ${runId}` }).select().single())).id;
  await must(admin.from("qbo_affiliate_vendor").insert({ affiliate_id: shopId, qbo_vendor_id: "301", qbo_vendor_name: "Shop Bill LLC" }));
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().eq("id", shopId);
  await admin.from("audit_log").delete().eq("row_id", shopId);
  expect(await must(admin.from("qbo_affiliate_vendor").select("affiliate_id").eq("affiliate_id", shopId))).toEqual([]);
}, 120_000);

describe("qbo_shop_bills and qbo_affiliate_vendor", () => {
  it("a shop reads nothing and cannot write", async () => {
    const wo = await order();
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: wo, status: "created", qb_bill_id: `b-${runId}`, qb_bill_number: "INV-1", qb_total: 10 }));
    for (const table of ["qbo_shop_bills", "qbo_affiliate_vendor"]) {
      const { data, error } = await shop.client.from(table).select("*").limit(5);
      expect(error ? [] : data, table).toEqual([]);
      const anonRead = await anon().from(table).select("*").limit(5);
      expect(anonRead.error ? [] : anonRead.data, table).toEqual([]);
    }
    expect((await shop.client.from("qbo_affiliate_vendor").insert({ affiliate_id: shopId, qbo_vendor_id: "9", qbo_vendor_name: "x" })).error).not.toBeNull();
    await shop.client.from("qbo_affiliate_vendor").update({ qbo_vendor_id: "9" }).eq("affiliate_id", shopId);
    await shop.client.from("qbo_shop_bills").update({ qb_bill_id: "9" }).eq("work_order_id", wo);
    await shop.client.from("qbo_shop_bills").delete().eq("work_order_id", wo);
    expect((await must(admin.from("qbo_affiliate_vendor").select("qbo_vendor_id").eq("affiliate_id", shopId).single())).qbo_vendor_id).toBe("301");
    expect((await must(admin.from("qbo_shop_bills").select("qb_bill_id").eq("work_order_id", wo).single())).qb_bill_id).toBe(`b-${runId}`);
  });

  it("CDS reads the bill but cannot write it; CDS reads and edits the vendor link (logged)", async () => {
    const wo = await order();
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: wo, status: "failed", error: "Invalid account" }));
    expect(await must(cds.client.from("qbo_shop_bills").select("status, error").eq("work_order_id", wo))).toEqual([{ status: "failed", error: "Invalid account" }]);
    expect((await cds.client.from("qbo_shop_bills").insert({ work_order_id: await order(), status: "created", qb_bill_id: "1" })).error).not.toBeNull();
    await cds.client.from("qbo_shop_bills").update({ status: "created", qb_bill_id: "1" }).eq("work_order_id", wo);
    expect((await must(admin.from("qbo_shop_bills").select("status").eq("work_order_id", wo).single())).status).toBe("failed");

    await must(cds.client.from("qbo_affiliate_vendor").update({ qbo_vendor_name: "Shop Bill LLC (TX)", updated_by: cds.id }).eq("affiliate_id", shopId));
    const log = await must(admin.from("audit_log").select("action, actor_id").eq("table_name", "qbo_affiliate_vendor").eq("row_id", shopId));
    expect(log).toContainEqual({ action: "update", actor_id: cds.id });
    expect((await admin.from("qbo_affiliate_vendor").update({ qbo_vendor_id: "abc" }).eq("affiliate_id", shopId)).error).not.toBeNull();
  });

  it("only the server can claim or finish a bill", async () => {
    const wo = await order();
    for (const client of [shop.client, cds.client, anon()]) {
      const c = await client.rpc("qbo_claim_shop_bill", { p_work_order: wo });
      expect(c.error?.code).toBe("42501");
      const f = await client.rpc("qbo_finish_shop_bill", { p_work_order: wo, p_claim: null, p_outcome: "error" });
      expect(f.error?.code).toBe("42501");
    }
    expect(await must(admin.from("qbo_shop_bills").select("work_order_id").eq("work_order_id", wo))).toEqual([]);
  });

  it("gives one claim per order, also to two requests at the same moment, and never a second bill", async () => {
    const wo = await order();
    const both = await Promise.all([claim(wo), claim(wo)]);
    const won = both.filter((r) => !r.error);
    expect(won).toHaveLength(1);
    expect(both.find((r) => r.error)?.error?.message).toBe("A QuickBooks bill is already being created for this work order. Refresh in a moment.");
    const c = won[0].data as { claim_id: string; request_id: string };
    expect(c.request_id).toBe(`bill-${wo}`);

    await must(finish(wo, c.claim_id, "created", { p_bill_id: "900", p_bill_number: "INV-1", p_total: 250, p_vendor_id: "301" }));
    const row = await must(admin.from("qbo_shop_bills").select("status, qb_bill_id, qb_bill_number, qb_total, claim_id").eq("work_order_id", wo).single());
    expect(row).toEqual({ status: "created", qb_bill_id: "900", qb_bill_number: "INV-1", qb_total: 250, claim_id: null });
    expect((await must(admin.from("work_order_internal").select("qb_bill_id").eq("work_order_id", wo).single())).qb_bill_id).toBe("900");
    const events = await must(admin.from("work_order_events").select("message, shop_visible").eq("work_order_id", wo).eq("event_type", "qbo_bill"));
    expect(events).toEqual([{ message: "QuickBooks bill INV-1 created for the shop ($250.00)", shop_visible: false }]);
    // The shop does not see that event.
    const seen = await shop.client.from("work_order_events").select("message").eq("work_order_id", wo).eq("event_type", "qbo_bill");
    expect(seen.data ?? []).toEqual([]);

    const again = await claim(wo);
    expect(again.error?.message).toBe("This work order already has QuickBooks bill INV-1.");
    // Clean up the bill id, which is unique across orders.
    await must(admin.from("qbo_shop_bills").delete().eq("work_order_id", wo));
  });

  it("a refusal moves to the next request id; an unclear failure keeps it; only the claim holder records a failure", async () => {
    const wo = await order();
    const first = (await must(claim(wo))) as { claim_id: string; request_id: string };
    await must(finish(wo, first.claim_id, "rejected", { p_error: "QuickBooks refused the bill: Invalid account" }));
    expect(await must(admin.from("qbo_shop_bills").select("status, error, rejections").eq("work_order_id", wo).single())).toEqual({
      status: "failed",
      error: "QuickBooks refused the bill: Invalid account",
      rejections: 1,
    });
    const second = (await must(claim(wo))) as { claim_id: string; request_id: string };
    expect(second.request_id).toBe(`bill-${wo}-r1`);
    // A stale holder cannot overwrite the live claim.
    await must(finish(wo, first.claim_id, "error", { p_error: "late" }));
    expect((await must(admin.from("qbo_shop_bills").select("status").eq("work_order_id", wo).single())).status).toBe("creating");
    await must(finish(wo, second.claim_id, "error", { p_error: "timeout" }));
    const third = (await must(claim(wo))) as { claim_id: string; request_id: string };
    expect(third.request_id).toBe(`bill-${wo}-r1`);
  });

  it("takes over a claim older than 5 minutes", async () => {
    const wo = await order();
    await must(claim(wo));
    await must(admin.from("qbo_shop_bills").update({ claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() }).eq("work_order_id", wo));
    expect((await claim(wo)).error).toBeNull();
  });

  it("refuses a cancelled order, an order the shop has not completed, and CDS's own shop", async () => {
    expect((await claim(await order({ status: "cancelled" }))).error?.message).toBe("This work order is cancelled, so it gets no shop bill.");
    expect((await claim(await order({ status: "invoiced", completed_at: null }))).error?.message).toBe("The shop has not completed this work order yet.");
    // Invoiced early, then completed: allowed.
    expect((await claim(await order({ status: "invoiced" }))).error).toBeNull();
    const inHouse = await must(admin.from("affiliates").select("id").eq("is_in_house", true).limit(1));
    if (inHouse.length) {
      expect((await claim(await order({ affiliate_id: inHouse[0].id }))).error?.message).toBe("CDS's own shop does not get a bill.");
    }
  });
});
