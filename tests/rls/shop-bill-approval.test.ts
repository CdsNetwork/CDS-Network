/**
 * Shop bill approval (Sarah, CDS, 2026-11-23: "every order please";
 * 20261123100000_shop_bill_approval.sql) and shops adding parts without an authorization
 * request.
 *
 * Approval: work_order_internal.shop_bill_approved_at / _by are CDS only (a shop reads and
 * sets nothing) and are set only by public.cds_approve_shop_bill (CDS, completed orders with
 * no bill yet). public.qbo_claim_shop_bill refuses an order CDS has not approved. Changing a
 * line, the shop's invoice number or the shop clears the approval until the bill exists;
 * after that nothing changes. work_order_list.shop_bill_pending_approval flags the completed
 * orders waiting for it.
 *
 * Parts: a shop adds any catalog part (not a service) with shop_add_part, and an item priced
 * per line (Misc. hardware) with shop_add_pass_through_line at the amount on its invoice;
 * services still need a request. The shop never reads the customer price.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 * Nothing here calls QuickBooks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `APPR-${runId}`;
let shopId: string;
let customer: string;
let part: string;
let service: string;
let misc: string;
let cds: Login;
let shop: Login;

async function insertOne(table: string, row: Record<string, unknown>): Promise<{ id: string }> {
  return must(admin.from(table).insert(row).select().single()) as Promise<{ id: string }>;
}

async function order(over: Record<string, unknown> = {}, internal: Record<string, unknown> = {}): Promise<string> {
  const completed = !("status" in over) || ["completed", "delivered", "ready_to_invoice", "invoiced"].includes(String(over.status));
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "unspecified",
    affiliate_id: shopId,
    status: "completed",
    completed_at: completed ? new Date().toISOString() : null,
    affiliate_invoice_ref: completed ? "INV-1" : null,
    unit_number: "A1",
    requested_work: "Test cleaning",
    ...over,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id, ...internal }));
  return wo.id;
}

const approval = async (wo: string) =>
  must(admin.from("work_order_internal").select("shop_bill_approved_at, shop_bill_approved_by").eq("work_order_id", wo).single());
const approve = (client: Login["client"], wo: string) => client.rpc("cds_approve_shop_bill", { p_work_order: wo });
const pending = async (wo: string) =>
  (await must(cds.client.from("work_order_list").select("shop_bill_pending_approval").eq("id", wo).single())).shop_bill_pending_approval;

beforeAll(async () => {
  shopId = (await insertOne("affiliates", { short_code: `APR-${runId}`, display_name: `Shop Approval ${runId}` })).id;
  customer = (await insertOne("customers", { code: `APC-${runId}`, name: `Customer Approval ${runId}` })).id;
  part = (await insertOne("catalog_items", { sku: `AP-P-${runId}`, category: "gasket", name: "Test gasket", tax_class: "parts" })).id;
  service = (await insertOne("catalog_items", { sku: `AP-S-${runId}`, category: "service", name: "Test service", tax_class: "labor" })).id;
  misc = (
    await insertOne("catalog_items", {
      sku: `AP-M-${runId}`,
      category: "part",
      name: "Test Misc. hardware",
      tax_class: "parts",
      shop_selectable: true,
      price_per_line: true,
      pass_through: true,
    })
  ).id;
  await must(admin.from("qbo_affiliate_vendor").insert({ affiliate_id: shopId, qbo_vendor_id: "401", qbo_vendor_name: "Shop Approval LLC" }));
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  const wos = (await must(admin.from("work_orders").select("id").eq("location_label", LABEL))).map((r: { id: string }) => r.id);
  if (wos.length) await admin.from("qbo_shop_bills").delete().in("work_order_id", wos);
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("catalog_items").delete().like("sku", `%-${runId}`);
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().eq("id", shopId);
  await admin.from("audit_log").delete().in("row_id", [shopId, customer, ...wos]);
}, 120_000);

describe("shop bill approval columns", () => {
  it("a shop and an anonymous caller read none of it and cannot approve or set it", async () => {
    const wo = await order();
    for (const client of [shop.client, anon()]) {
      const { data, error } = await client.from("work_order_internal").select("shop_bill_approved_at").eq("work_order_id", wo);
      expect(error ? [] : data).toEqual([]);
      expect((await approve(client, wo)).error).not.toBeNull();
      await client.from("work_order_internal").update({ shop_bill_approved_at: new Date().toISOString() }).eq("work_order_id", wo);
      const view = await client.from("work_order_list").select("id").eq("id", wo);
      expect(view.error ? [] : view.data).toEqual([]);
    }
    expect(await approval(wo)).toEqual({ shop_bill_approved_at: null, shop_bill_approved_by: null });
  });

  it("CDS approves only through the function, which records who and when (logged, CDS only)", async () => {
    const wo = await order();
    const direct = await cds.client.from("work_order_internal").update({ shop_bill_approved_at: new Date().toISOString(), shop_bill_approved_by: cds.id }).eq("work_order_id", wo);
    expect(direct.error?.message).toMatch(/Approve and send/);
    const t0 = Date.now();
    await must(approve(cds.client, wo));
    const row = await approval(wo);
    expect(row.shop_bill_approved_by).toBe(cds.id);
    expect(Math.abs(Date.parse(row.shop_bill_approved_at as string) - t0)).toBeLessThan(60_000);
    const events = await must(admin.from("work_order_events").select("event_type, actor_id, shop_visible").eq("work_order_id", wo).eq("event_type", "shop_bill_approved"));
    expect(events).toEqual([{ event_type: "shop_bill_approved", actor_id: cds.id, shop_visible: false }]);
  });

  it("refuses an order the shop has not completed, a cancelled order, and an order whose bill exists", async () => {
    expect((await approve(cds.client, await order({ status: "in_process" }))).error?.message).toBe("The shop has not completed this work order yet.");
    expect((await approve(cds.client, await order({ status: "cancelled" }))).error?.message).toBe("This work order is cancelled, so it gets no shop bill.");
    const billed = await order();
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: billed, status: "created", qb_bill_id: `ap-${runId}`, qb_bill_number: "INV-1", qb_total: 10 }));
    expect((await approve(cds.client, billed)).error?.message).toBe("This work order already has QuickBooks bill INV-1.");
  });

  it("the bill is claimed only after CDS approved it", async () => {
    const wo = await order();
    expect((await admin.rpc("qbo_claim_shop_bill", { p_work_order: wo })).error?.message).toBe(
      "CDS has not approved this shop bill yet. Approve it on the work order first.",
    );
    expect(await must(admin.from("qbo_shop_bills").select("work_order_id").eq("work_order_id", wo))).toEqual([]);
    await must(approve(cds.client, wo));
    expect((await admin.rpc("qbo_claim_shop_bill", { p_work_order: wo })).error).toBeNull();
  });

  it("a line change, a new shop invoice number or another shop clears the approval until the bill exists", async () => {
    const wo = await order();
    await must(approve(cds.client, wo));
    await must(cds.client.rpc("cds_add_pass_through_line", { p_work_order: wo, p_catalog_item: misc, p_description: "Kit bolts", p_amount: 9.5 }));
    expect((await approval(wo)).shop_bill_approved_at).toBeNull();

    await must(approve(cds.client, wo));
    const line = (await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo).single())).id as string;
    await must(cds.client.rpc("cds_remove_pass_through_line", { p_line: line }));
    expect((await approval(wo)).shop_bill_approved_at).toBeNull();

    await must(approve(cds.client, wo));
    await must(cds.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: part, qty: 2, origin: "cds_order" }));
    expect((await approval(wo)).shop_bill_approved_at).toBeNull();

    await must(approve(cds.client, wo));
    await must(admin.from("work_orders").update({ affiliate_invoice_ref: "INV-2" }).eq("id", wo));
    expect((await approval(wo)).shop_bill_approved_at).toBeNull();

    // Something else on the order (the unit number) keeps it.
    await must(approve(cds.client, wo));
    await must(admin.from("work_orders").update({ unit_number: "A2" }).eq("id", wo));
    expect((await approval(wo)).shop_bill_approved_at).not.toBeNull();

    // Once the bill exists, a change no longer touches the approval.
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: wo, status: "created", qb_bill_id: `ap2-${runId}`, qb_bill_number: "INV-2", qb_total: 19 }));
    await must(cds.client.rpc("cds_add_pass_through_line", { p_work_order: wo, p_catalog_item: misc, p_description: "Late bolts", p_amount: 1 }));
    expect((await approval(wo)).shop_bill_approved_at).not.toBeNull();
  });

  it("a deleted order with an approval goes cleanly", async () => {
    const wo = await order();
    await must(cds.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: part, qty: 1, origin: "cds_order" }));
    await must(approve(cds.client, wo));
    await must(admin.from("work_orders").delete().eq("id", wo));
    expect(await must(admin.from("work_order_internal").select("work_order_id").eq("work_order_id", wo))).toEqual([]);
  });
});

describe("work_order_list.shop_bill_pending_approval", () => {
  it("flags completed orders with no bill and no approval; not open, approved, billed or cancelled ones", async () => {
    const waiting = await order();
    expect(await pending(waiting)).toBe(true);
    // Invoiced to the customer first: the shop bill still waits (independent of the invoice).
    expect(await pending(await order({ status: "invoiced" }))).toBe(true);
    expect(await pending(await order({ status: "in_process" }))).toBe(false);
    expect(await pending(await order({ status: "cancelled" }))).toBe(false);

    const approved = await order();
    await must(approve(cds.client, approved));
    expect(await pending(approved)).toBe(false);

    const billed = await order();
    await must(admin.from("qbo_shop_bills").insert({ work_order_id: billed, status: "created", qb_bill_id: `ap3-${runId}`, qb_bill_number: "INV-1", qb_total: 10 }));
    expect(await pending(billed)).toBe(false);

    // The filter the dashboard uses.
    const ids = (await must(cds.client.from("work_order_list").select("id").eq("location_label", LABEL).eq("shop_bill_pending_approval", true))).map(
      (r: { id: string }) => r.id,
    );
    expect(ids).toContain(waiting);
    expect(ids).not.toContain(approved);
    expect(ids).not.toContain(billed);
  });

  it("CDS's own shop: only once it is linked to a vendor, for orders completed after the link", async () => {
    const inHouse = (await must(admin.from("affiliates").select("id").eq("is_in_house", true).single())).id as string;
    const before = await must(admin.from("qbo_affiliate_vendor").select("*").eq("affiliate_id", inHouse));
    try {
      if (before.length) await must(admin.from("qbo_affiliate_vendor").delete().eq("affiliate_id", inHouse));
      const wo = await order({ affiliate_id: inHouse, completed_at: new Date(Date.now() - 3600_000).toISOString() });
      expect(await pending(wo)).toBe(false);
      await must(admin.from("qbo_affiliate_vendor").insert({ affiliate_id: inHouse, qbo_vendor_id: "777", qbo_vendor_name: "GESi" }));
      // Completed before the link: CDS may have entered it by hand, so it is not flagged.
      expect(await pending(wo)).toBe(false);
      expect(await pending(await order({ affiliate_id: inHouse }))).toBe(true);
    } finally {
      await admin.from("qbo_affiliate_vendor").delete().eq("affiliate_id", inHouse);
      if (before.length) await must(admin.from("qbo_affiliate_vendor").insert(before));
    }
  });
});

describe("shops add parts without an authorization request", () => {
  it("adds a catalog part directly; a service is refused and still goes through a request", async () => {
    const wo = await order({ status: "in_process" });
    await must(shop.client.rpc("shop_add_part", { p_work_order: wo, p_catalog_item: part, p_qty: 2 }));
    const svc = await shop.client.rpc("shop_add_part", { p_work_order: wo, p_catalog_item: service, p_qty: 1 });
    expect(svc.error?.message).toMatch(/Services need an additional authorization request/);
    await must(shop.client.rpc("shop_request_authorization", { p_work_order: wo, p_catalog_item: service, p_qty: 1, p_note: "Extra labor" }));
    const lines = await must(admin.from("work_order_lines").select("catalog_item_id, qty, origin").eq("work_order_id", wo));
    expect(lines).toEqual([{ catalog_item_id: part, qty: 2, origin: "shop_added" }]);
  });

  it("adds Misc. hardware at the amount on its invoice; the customer is billed the same; the shop never reads that price", async () => {
    const wo = await order({ status: "in_process" });
    const id = (await must(
      shop.client.rpc("shop_add_pass_through_line", { p_work_order: wo, p_catalog_item: misc, p_description: " Bolts for the DPF kit ", p_amount: 12.4 }),
    )) as string;
    expect(typeof id).toBe("string");
    const line = await must(admin.from("work_order_lines").select("qty, shop_unit_rate, shop_rate_source, description, origin").eq("id", id).single());
    expect(line).toEqual({ qty: 1, shop_unit_rate: 12.4, shop_rate_source: "manual", description: "Bolts for the DPF kit", origin: "shop_added" });
    expect((await must(admin.from("work_order_line_pricing").select("customer_unit_price").eq("line_id", id).single())).customer_unit_price).toBe(12.4);
    const priced = await shop.client.from("work_order_line_pricing").select("*").eq("work_order_id", wo);
    expect(priced.error ? [] : priced.data).toEqual([]);
    expect(await must(shop.client.from("work_order_lines").select("description, shop_unit_rate").eq("work_order_id", wo))).toEqual([
      { description: "Bolts for the DPF kit", shop_unit_rate: 12.4 },
    ]);
    const events = await must(admin.from("work_order_events").select("event_type, shop_visible").eq("work_order_id", wo).eq("event_type", "line_added"));
    expect(events).toEqual([{ event_type: "line_added", shop_visible: true }]);
    // Its own line: the shop may remove it while it works on the job.
    await must(shop.client.rpc("shop_remove_part", { p_work_order: wo, p_line: id }));
    expect(await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo))).toEqual([]);
  });

  it("refuses Misc. hardware without a description or amount, as a plain part, after completion, and on another shop's job", async () => {
    const wo = await order({ status: "in_process" });
    const add = (client: Login["client"], w: string, description: string, amount: number | null) =>
      client.rpc("shop_add_pass_through_line", { p_work_order: w, p_catalog_item: misc, p_description: description, p_amount: amount });
    expect((await add(shop.client, wo, " ", 5)).error?.message).toMatch(/description/);
    for (const amount of [null, 0, -1, 1.234, 100000]) expect((await add(shop.client, wo, "Bolts", amount)).error, String(amount)).not.toBeNull();
    expect((await shop.client.rpc("shop_add_part", { p_work_order: wo, p_catalog_item: misc, p_qty: 1 })).error?.message).toMatch(/amount on your invoice/);
    expect((await shop.client.rpc("shop_add_pass_through_line", { p_work_order: wo, p_catalog_item: part, p_description: "x", p_amount: 5 })).error?.message).toMatch(
      /not priced per line/,
    );
    expect((await add(shop.client, await order(), "Bolts", 5)).error?.message).toMatch(/can no longer be edited/);
    expect((await add(anon(), wo, "Bolts", 5)).error).not.toBeNull();
    // A direct insert by the shop is still refused.
    expect((await shop.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: misc, qty: 1, shop_unit_rate: 5 })).error).not.toBeNull();
    expect(await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo))).toEqual([]);
  });
});
