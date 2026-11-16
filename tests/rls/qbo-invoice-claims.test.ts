/**
 * Claiming the customer invoice before QuickBooks is called (20261118030000_qbo_invoice_claims.sql).
 *
 * Review 2026-11-16 H3: the request id came from the number of refused attempts in
 * integration_sync, so two overlapping failures could give two different ids and two invoices.
 * H4: the invoice inputs stayed editable while QuickBooks created the invoice, so a change made
 * meanwhile was recorded against an invoice built from the older details.
 *
 * One claim per order at a time, with the request id; the id moves on only after QuickBooks
 * clearly refused. While a claim is live, or QuickBooks has not confirmed, or the invoice was
 * created but not recorded, the invoice inputs (lines, prices, customer, location, PO, unit,
 * tax) cannot change and the order cannot be cancelled.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 * Nothing here calls QuickBooks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `QIC-${runId}`;
let shopId: string;
let customer: string;
let otherCustomer: string;
let part: string;
let cds: Login;
let otherCds: Login;
let shop: Login;
let seq = 0;

const BEING_CREATED = "The invoice for this work order is being created in QuickBooks. Try again in a moment.";
const NOT_CONFIRMED = "QuickBooks has not confirmed the invoice for this work order yet. Click Create QuickBooks invoice again, then make the change.";
const NOT_RECORDED = "The QuickBooks invoice for this work order was created but is not recorded yet. Click Create QuickBooks invoice to record it.";

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

/** An order the shop is working on, with one priced part line. */
async function order(): Promise<{ id: string; line: string }> {
  seq += 1;
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shopId,
    status: "in_process",
    unit_number: `U-${seq}`,
    po_number: `PO-${seq}`,
    requested_work: "Test cleaning",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  const line = await insertOne("work_order_lines", { work_order_id: wo.id, catalog_item_id: part, qty: 1, origin: "cds_order" });
  return { id: wo.id, line: line.id };
}

type Claimed = { state: string; claim_id: string; attempt: number; request_id: string; snapshot: string | null; qb_invoice_id?: string };
const claim = (login: Login, wo: string, snapshot: string | null = "snap-a") =>
  login.client.rpc("cds_claim_qbo_invoice", { p_work_order: wo, p_snapshot: snapshot });
const finish = (login: Login, wo: string, claimId: string, outcome: string, qbInvoiceId: string | null = null) =>
  login.client.rpc("cds_finish_qbo_invoice", { p_work_order: wo, p_claim: claimId, p_outcome: outcome, p_qb_invoice_id: qbInvoiceId });

/** Every invoice input change CDS can make, each on its own; returns the error messages. */
async function editErrors(wo: { id: string; line: string }): Promise<(string | null)[]> {
  const c = cds.client;
  const results = [
    await c.from("work_order_line_pricing").update({ customer_unit_price: 99 }).eq("line_id", wo.line).select("line_id"),
    await c.from("work_order_lines").update({ qty: 2 }).eq("id", wo.line).select("id"),
    await c.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: part, qty: 1, origin: "cds_order" }).select("id"),
    await c.from("work_orders").update({ po_number: "PO-CHANGED" }).eq("id", wo.id).select("id"),
    await c.from("work_orders").update({ customer_id: otherCustomer }).eq("id", wo.id).select("id"),
    await c.from("work_order_internal").update({ tax_rate: 7.5, tax_parts: true }).eq("work_order_id", wo.id).select("work_order_id"),
    await c.rpc("cds_set_status", { p_work_order: wo.id, p_status: "cancelled", p_note: null }),
  ];
  return results.map((r) => r.error?.message ?? null);
}

const claimRow = async (wo: string) =>
  must(admin.from("qbo_invoice_claims").select("state, attempt, snapshot, qb_invoice_id").eq("work_order_id", wo).single());

beforeAll(async () => {
  shopId = (await insertOne("affiliates", { short_code: `QIC-${runId}`, display_name: `Shop QIC ${runId}` })).id;
  customer = (await insertOne("customers", { code: `QIC-${runId}`, name: `Customer QIC ${runId}` })).id;
  otherCustomer = (await insertOne("customers", { code: `QICO-${runId}`, name: `Other QIC ${runId}` })).id;
  part = (await insertOne("catalog_items", { sku: `QICP-${runId}`, category: "part", name: "Test part", tax_class: "parts" })).id;
  await must(admin.from("sell_prices").insert({ catalog_item_id: part, market: "US", amount: 30, effective_from: "2026-01-01" }));
  await must(admin.from("shop_rates").insert({ catalog_item_id: part, market: "US", amount: 20, effective_from: "2026-01-01" }));
  cds = await createLogin("cds", null);
  otherCds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  await admin.from("integration_sync").delete().like("error", `QIC ${runId}%`);
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("catalog_items").delete().like("sku", suffix);
  await admin.from("customers").delete().like("code", suffix);
  await admin.from("affiliates").delete().like("short_code", suffix);
}, 120_000);

describe("cds_claim_qbo_invoice", () => {
  it("gives one claim at a time, also to two requests at the same moment", async () => {
    const wo = await order();
    const both = await Promise.all([claim(cds, wo.id), claim(otherCds, wo.id)]);
    const won = both.filter((r) => !r.error);
    expect(won).toHaveLength(1);
    expect(both.find((r) => r.error)?.error?.message).toBe("This invoice is already being created. Refresh in a moment.");
    expect(won[0].data).toMatchObject({ state: "sending", attempt: 0, request_id: wo.id, snapshot: "snap-a" });
  });

  it("starts after the refusals recorded before claims existed, so an old request id is never reused", async () => {
    const wo = await order();
    for (const n of [1, 2]) {
      await must(
        admin.from("integration_sync").insert({
          system: "quickbooks",
          entity: "invoice",
          entity_id: wo.id,
          direction: "push",
          status: "rejected",
          error: `QIC ${runId} refusal ${n}`,
        }),
      );
    }
    const c = (await must(claim(cds, wo.id))) as Claimed;
    expect(c).toMatchObject({ attempt: 2, request_id: `${wo.id}-r2` });
  });

  it("moves to the next request id once per refusal, never per failure row, and only for the holder of the claim", async () => {
    const wo = await order();
    const first = (await must(claim(cds, wo.id))) as Claimed;
    await must(finish(cds, wo.id, first.claim_id, "refused"));
    // The same refusal reported again (a second failing request, a retry of the call): no change.
    await must(finish(otherCds, wo.id, first.claim_id, "refused"));
    expect(await claimRow(wo.id)).toMatchObject({ state: "idle", attempt: 1 });
    const second = (await must(claim(cds, wo.id))) as Claimed;
    expect(second.request_id).toBe(`${wo.id}-r1`);
    // A late refusal from the first claim cannot move the live one on.
    await must(finish(cds, wo.id, first.claim_id, "refused"));
    expect(await claimRow(wo.id)).toMatchObject({ state: "sending", attempt: 1 });
  });

  it("keeps the request id after an unclear answer and returns the details that request was built from", async () => {
    const wo = await order();
    const first = (await must(claim(cds, wo.id, "snap-old"))) as Claimed;
    await must(finish(cds, wo.id, first.claim_id, "unconfirmed"));
    const retry = (await must(claim(otherCds, wo.id, "snap-new"))) as Claimed;
    expect(retry).toMatchObject({ state: "sending", attempt: 0, request_id: wo.id, snapshot: "snap-old" });
    // Failing before QuickBooks was called again leaves it unconfirmed.
    await must(finish(otherCds, wo.id, retry.claim_id, "not_sent"));
    expect(await claimRow(wo.id)).toMatchObject({ state: "unconfirmed", attempt: 0, snapshot: "snap-old" });
  });

  it("takes over a claim older than 5 minutes, with the same request id", async () => {
    const wo = await order();
    await must(claim(cds, wo.id, "snap-crash"));
    await must(admin.from("qbo_invoice_claims").update({ claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() }).eq("work_order_id", wo.id));
    const again = (await must(claim(otherCds, wo.id, "snap-b"))) as Claimed;
    expect(again).toMatchObject({ state: "sending", request_id: wo.id, snapshot: "snap-crash" });
  });

  it("hands back an invoice created but not recorded instead of a claim", async () => {
    const wo = await order();
    const c = (await must(claim(cds, wo.id, "snap-c"))) as Claimed;
    await must(finish(cds, wo.id, c.claim_id, "created", `QIC${runId}c`));
    const again = (await must(claim(otherCds, wo.id, "snap-other"))) as Claimed;
    expect(again).toMatchObject({ state: "created", qb_invoice_id: `QIC${runId}c`, snapshot: "snap-c" });
  });

  it("refuses an order that already has its invoice, and shops", async () => {
    const wo = await order();
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: wo.id, p_qb_invoice_id: `QIC${runId}m`, p_qb_invoice_number: null }));
    expect((await claim(cds, wo.id)).error?.message).toBe(`This work order already has QuickBooks invoice QIC${runId}m`);
    const other = await order();
    expect((await claim(shop, other.id)).error).not.toBeNull();
    expect((await shop.client.from("qbo_invoice_claims").select("work_order_id").eq("work_order_id", other.id)).data ?? []).toEqual([]);
  });
});

describe("the invoice inputs while the invoice is being created", () => {
  it("cannot change while a claim is live", async () => {
    const wo = await order();
    await must(claim(cds, wo.id));
    expect(await editErrors(wo)).toEqual(Array(7).fill(BEING_CREATED));
    // The shop adding a part is refused too; its own work (status, notes) is not.
    const added = await shop.client.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: part, qty: 1, origin: "shop_added" });
    expect(added.error?.message).toBe(BEING_CREATED);
    const row = await must(admin.from("work_orders").select("po_number, customer_id").eq("id", wo.id).single());
    expect(row).toEqual({ po_number: expect.stringMatching(/^PO-/), customer_id: customer });
  });

  it("cannot change while QuickBooks has not confirmed, or after a crash, until the invoice is created again", async () => {
    const wo = await order();
    const c = (await must(claim(cds, wo.id))) as Claimed;
    await must(finish(cds, wo.id, c.claim_id, "unconfirmed"));
    expect(await editErrors(wo)).toEqual(Array(7).fill(NOT_CONFIRMED));

    const crashed = await order();
    await must(claim(cds, crashed.id));
    await must(admin.from("qbo_invoice_claims").update({ claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() }).eq("work_order_id", crashed.id));
    expect((await editErrors(crashed))[0]).toBe(NOT_CONFIRMED);
  });

  it("cannot change once QuickBooks created the invoice, before it is recorded", async () => {
    const wo = await order();
    const c = (await must(claim(cds, wo.id))) as Claimed;
    await must(finish(cds, wo.id, c.claim_id, "created", `QIC${runId}r`));
    expect(await editErrors(wo)).toEqual(Array(7).fill(NOT_RECORDED));
  });

  it("can change again after a refusal or when nothing was sent", async () => {
    for (const outcome of ["refused", "not_sent"]) {
      const wo = await order();
      const c = (await must(claim(cds, wo.id))) as Claimed;
      await must(finish(cds, wo.id, c.claim_id, outcome));
      expect((await editErrors(wo)).slice(0, 6), outcome).toEqual(Array(6).fill(null));
    }
  });

  it("does not stop deleting the order", async () => {
    const wo = await order();
    await must(claim(cds, wo.id));
    await must(admin.from("profiles").update({ can_delete_work_orders: true }).eq("id", otherCds.id));
    await must(otherCds.client.rpc("cds_delete_work_order", { p_work_order: wo.id }));
    expect(await must(admin.from("work_orders").select("id").eq("id", wo.id))).toEqual([]);
    expect(await must(admin.from("qbo_invoice_claims").select("work_order_id").eq("work_order_id", wo.id))).toEqual([]);
  });
});
