/**
 * One order across 2 shops (CDS, 2026-11-17, milestone M4; 20261119080000_combined_invoice.sql):
 * two linked work orders get one customer invoice in QuickBooks.
 *
 *   * The claim is taken on the first work order (lowest WO number) and names the other one,
 *     from whichever page; one claim at a time for the pair, so two pages never send two
 *     invoices. While it is open, the invoice inputs of BOTH work orders are locked.
 *   * cds_mark_invoiced_linked records the same QuickBooks invoice on both at once; a
 *     QuickBooks invoice id or number is otherwise still recorded on one work order only.
 *   * A link cannot be removed once the pair's invoice is started or recorded; a work order
 *     with its own invoice cannot be linked; a pair cannot take a third work order.
 *   * Shops see none of it: not the other work order, not the claim, not the link.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 * Nothing here calls QuickBooks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `CMB-${runId}`;
let shopA: string;
let shopB: string;
let customer: string;
let part: string;
let cds: Login;
let otherCds: Login;
let loginA: Login;

type Wo = { id: string; line: string; wo_number: number };
type Claimed = { state: string; claim_id: string; attempt: number; request_id: string; snapshot: string | null; work_order_id: string; linked_work_order_id: string | null; qb_invoice_id?: string };

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

/** An order with one priced part line, at the given shop and status. */
async function order(affiliate: string, status = "in_process"): Promise<Wo> {
  const wo = await insertOne<{ id: string; wo_number: number }>("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: affiliate,
    status,
    unit_number: "T-77",
    po_number: "0899253330",
    requested_work: "Test cleaning",
    affiliate_invoice_ref: `REF-${runId}`,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  const line = await insertOne("work_order_lines", { work_order_id: wo.id, catalog_item_id: part, qty: 1, origin: "cds_order" });
  return { id: wo.id, line: line.id, wo_number: wo.wo_number };
}

/** Two orders of one customer order at two shops, linked by CDS (first one done, second still working). */
async function pair(): Promise<[Wo, Wo]> {
  const a = await order(shopA, "completed");
  const b = await order(shopB, "in_process");
  await must(cds.client.from("work_order_links").insert({ work_order_id: b.id, linked_work_order_id: a.id }));
  return [a, b];
}

const claim = (login: Login, wo: string, linked: string | null, snapshot = "snap-a") =>
  login.client.rpc("cds_claim_qbo_invoice", { p_work_order: wo, p_snapshot: snapshot, ...(linked ? { p_linked: linked } : {}) });
const finish = (login: Login, wo: string, claimId: string | null, outcome: string, qbInvoiceId: string | null = null) =>
  login.client.rpc("cds_finish_qbo_invoice", { p_work_order: wo, p_claim: claimId, p_outcome: outcome, p_qb_invoice_id: qbInvoiceId });
const markLinked = (login: Login, owner: string, linked: string, id: string, number: string | null = null) =>
  login.client.rpc("cds_mark_invoiced_linked", {
    p_work_order: owner,
    p_linked: linked,
    p_qb_invoice_id: id,
    p_qb_invoice_number: number,
    p_qb_tax_total: 12.5,
    p_qb_total: 312.5,
  });
const internal = async (wo: string) =>
  must(admin.from("work_order_internal").select("qb_invoice_id, qb_invoice_number, qb_total").eq("work_order_id", wo).single());
const status = async (wo: string) => (await must(admin.from("work_orders").select("status").eq("id", wo).single())).status as string;

/** Creates the pair's invoice up to QuickBooks' answer and returns the claim. */
async function created(a: Wo, b: Wo, id: string): Promise<Claimed> {
  const c = (await must(claim(cds, b.id, a.id))) as Claimed;
  await must(finish(cds, c.work_order_id, c.claim_id, "created", id));
  return c;
}

beforeAll(async () => {
  shopA = (await insertOne("affiliates", { short_code: `CMA-${runId}`, display_name: `Combined Shop A ${runId}` })).id;
  shopB = (await insertOne("affiliates", { short_code: `CMB-${runId}`, display_name: `Combined Shop B ${runId}` })).id;
  customer = (await insertOne("customers", { code: `CMC-${runId}`, name: `Combined Customer ${runId}` })).id;
  part = (await insertOne("catalog_items", { sku: `CMP-${runId}`, category: "part", name: "Test part", tax_class: "parts" })).id;
  await must(admin.from("sell_prices").insert({ catalog_item_id: part, market: "US", amount: 30, effective_from: "2026-01-01" }));
  await must(admin.from("shop_rates").insert({ catalog_item_id: part, market: "US", amount: 20, effective_from: "2026-01-01" }));
  cds = await createLogin("cds", null);
  otherCds = await createLogin("cds", null);
  loginA = await createLogin("shop", shopA);
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("catalog_items").delete().like("sku", suffix);
  await admin.from("customers").delete().like("code", suffix);
  await admin.from("affiliates").delete().like("short_code", suffix);
}, 120_000);

describe("the claim of two linked work orders", () => {
  it("is on the first work order and names the other, from either page", async () => {
    const [a, b] = await pair();
    const fromB = (await must(claim(cds, b.id, a.id))) as Claimed;
    expect(fromB).toMatchObject({ state: "sending", work_order_id: a.id, linked_work_order_id: b.id, request_id: a.id });
    await must(finish(cds, a.id, fromB.claim_id, "not_sent"));
    const fromA = (await must(claim(cds, a.id, b.id))) as Claimed;
    expect(fromA).toMatchObject({ state: "sending", work_order_id: a.id, linked_work_order_id: b.id, request_id: a.id });
  });

  it("is given once when both pages ask at the same moment", async () => {
    const [a, b] = await pair();
    const both = await Promise.all([claim(cds, a.id, b.id), claim(otherCds, b.id, a.id)]);
    expect(both.filter((r) => !r.error)).toHaveLength(1);
    expect(both.find((r) => r.error)?.error?.message).toBe("This invoice is already being created. Refresh in a moment.");
  });

  it("is refused when the page built the invoice for another link than the one in the database", async () => {
    const [a, b] = await pair();
    // Built as a work order on its own (an old page, or linked meanwhile).
    expect((await claim(cds, a.id, null)).error?.message).toBe(
      `WO-${a.wo_number} is linked to WO-${b.wo_number}, so the invoice covers both. Reload the page and try again.`,
    );
    const single = await order(shopA);
    expect((await claim(cds, single.id, a.id)).error?.message).toBe("The linked work orders changed. Reload the page and try again.");
  });

  it("is refused when the other work order is cancelled or has its own invoice, naming it", async () => {
    const a = await order(shopA, "completed");
    const b = await order(shopB, "in_process");
    await must(cds.client.from("work_order_links").insert({ work_order_id: a.id, linked_work_order_id: b.id }));
    await must(admin.from("work_orders").update({ status: "cancelled" }).eq("id", b.id));
    expect((await claim(cds, a.id, b.id)).error?.message).toBe(
      `Linked work order WO-${b.wo_number} is cancelled. Remove the link to invoice this work order on its own.`,
    );
    await must(admin.from("work_orders").update({ status: "completed" }).eq("id", b.id));
    // Recorded before the link (service role: a signed-in user cannot link it any more).
    await must(admin.from("work_order_internal").update({ qb_invoice_id: `CMB${runId}own` }).eq("work_order_id", b.id));
    expect((await claim(cds, a.id, b.id)).error?.message).toBe(
      `Linked work order WO-${b.wo_number} already has QuickBooks invoice CMB${runId}own. Remove the link to invoice this work order on its own.`,
    );
  });

  it("is refused while an invoice of the other work order on its own may be in QuickBooks", async () => {
    const a = await order(shopA, "completed");
    const b = await order(shopB, "completed");
    const solo = (await must(claim(cds, b.id, null))) as Claimed;
    await must(finish(cds, b.id, solo.claim_id, "unconfirmed"));
    await must(admin.from("work_order_links").insert({ work_order_id: a.id, linked_work_order_id: b.id }));
    expect((await claim(cds, a.id, b.id)).error?.message).toBe(
      `An invoice for WO-${b.wo_number} on its own was started in QuickBooks before the link. Remove the link and click Create QuickBooks invoice on WO-${b.wo_number} to finish it.`,
    );
  });

  it("locks the invoice inputs of both work orders while it is open", async () => {
    const [a, b] = await pair();
    await must(claim(cds, a.id, b.id));
    const BEING = "The invoice for this work order is being created in QuickBooks. Try again in a moment.";
    for (const wo of [a, b]) {
      const r = await cds.client.from("work_order_lines").update({ qty: 2 }).eq("id", wo.line).select("id");
      expect(r.error?.message, wo === a ? "first" : "second").toBe(BEING);
      const po = await cds.client.from("work_orders").update({ po_number: "OTHER" }).eq("id", wo.id).select("id");
      expect(po.error?.message).toBe(BEING);
    }
  });
});

describe("recording the invoice on both work orders", () => {
  it("records the same invoice on both; the done one is Invoiced, the other moves on completion", async () => {
    const [a, b] = await pair();
    await created(a, b, `CMB${runId}r`);
    await must(markLinked(cds, a.id, b.id, `CMB${runId}r`, `N${runId}r`));
    for (const wo of [a, b]) {
      expect(await internal(wo.id)).toEqual({ qb_invoice_id: `CMB${runId}r`, qb_invoice_number: `N${runId}r`, qb_total: 312.5 });
    }
    expect(await status(a.id)).toBe("invoiced");
    expect(await status(b.id)).toBe("in_process");
    // A second invoice is never started for either.
    expect((await claim(cds, b.id, a.id)).error?.message).toBe(`This work order already has QuickBooks invoice CMB${runId}r`);
    expect((await claim(cds, a.id, b.id)).error?.message).toBe("This work order is already invoiced");
    // Both pages' events name both work orders (CDS only).
    const events = (await must(
      admin.from("work_order_events").select("work_order_id, message, shop_visible").in("work_order_id", [a.id, b.id]).like("message", "%covers%"),
    )) as { work_order_id: string; message: string; shop_visible: boolean }[];
    expect(events.map((e) => e.work_order_id).sort()).toEqual([a.id, b.id].sort());
    expect(events.every((e) => !e.shop_visible && e.message.includes(`WO-${a.wo_number}`) && e.message.includes(`WO-${b.wo_number}`))).toBe(true);
  });

  it("records it once when two requests record it at the same moment", async () => {
    const [a, b] = await pair();
    await created(a, b, `CMB${runId}c`);
    const both = await Promise.all([markLinked(cds, a.id, b.id, `CMB${runId}c`), markLinked(otherCds, a.id, b.id, `CMB${runId}c`)]);
    expect(both.filter((r) => !r.error)).toHaveLength(1);
    const rows = (await must(admin.from("work_order_internal").select("work_order_id").eq("qb_invoice_id", `CMB${runId}c`))) as unknown[];
    expect(rows).toHaveLength(2);
  });

  it("is refused without the pair's created invoice on the claim", async () => {
    const [a, b] = await pair();
    expect((await markLinked(cds, a.id, b.id, `CMB${runId}x`)).error?.message).toBe(
      "This QuickBooks invoice was not created for these linked work orders. Click Create QuickBooks invoice again.",
    );
    const c = (await must(claim(cds, a.id, b.id))) as Claimed;
    await must(finish(cds, a.id, c.claim_id, "created", `CMB${runId}y`));
    expect((await markLinked(cds, a.id, b.id, `CMB${runId}other`)).error).not.toBeNull();
    expect((await markLinked(cds, b.id, a.id, `CMB${runId}y`)).error).not.toBeNull();
    expect((await internal(a.id)).qb_invoice_id).toBeNull();
  });

  it("a QuickBooks invoice id or number is still recorded on one work order only otherwise", async () => {
    const [a, b] = await pair();
    await created(a, b, `CMB${runId}u`);
    await must(markLinked(cds, a.id, b.id, `CMB${runId}u`, `N${runId}u`));
    const single = await order(shopA, "completed");
    const sameId = await cds.client.rpc("cds_mark_invoiced", { p_work_order: single.id, p_qb_invoice_id: `CMB${runId}u`, p_qb_invoice_number: null });
    expect(sameId.error?.message).toMatch(/already recorded on another work order/);
    const sameNumber = await cds.client.rpc("cds_mark_invoiced", { p_work_order: single.id, p_qb_invoice_id: `CMB${runId}v`, p_qb_invoice_number: `N${runId}u` });
    expect(sameNumber.error?.message).toMatch(/already recorded on another work order/);
    // Two single orders, as before.
    const one = await order(shopA, "completed");
    const two = await order(shopA, "completed");
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: one.id, p_qb_invoice_id: `CMB${runId}w`, p_qb_invoice_number: null }));
    expect((await cds.client.rpc("cds_mark_invoiced", { p_work_order: two.id, p_qb_invoice_id: `CMB${runId}w`, p_qb_invoice_number: null })).error).not.toBeNull();
  });
});

describe("links and the shared invoice", () => {
  it("cannot be removed once the invoice is started or recorded", async () => {
    const [a, b] = await pair();
    const c = (await must(claim(cds, a.id, b.id))) as Claimed;
    const live = await cds.client.from("work_order_links").delete().eq("work_order_id", b.id).select("work_order_id");
    expect(live.error?.message).toBe(
      `The QuickBooks invoice for WO-${a.wo_number} and WO-${b.wo_number} is being created, so the link cannot be removed. Click Create QuickBooks invoice to finish it first.`,
    );
    await must(finish(cds, a.id, c.claim_id, "created", `CMB${runId}l`));
    await must(markLinked(cds, a.id, b.id, `CMB${runId}l`, `N${runId}l`));
    const recorded = await cds.client.from("work_order_links").delete().eq("work_order_id", b.id).select("work_order_id");
    expect(recorded.error?.message).toBe(
      `WO-${a.wo_number} and WO-${b.wo_number} share QuickBooks invoice N${runId}l, so the link cannot be removed.`,
    );
    const moved = await cds.client.from("work_order_links").update({ linked_work_order_id: (await order(shopA)).id }).eq("work_order_id", b.id).select("work_order_id");
    expect(moved.error).not.toBeNull();
    expect(await must(admin.from("work_order_links").select("linked_work_order_id").eq("work_order_id", b.id).single())).toEqual({ linked_work_order_id: a.id });
  });

  it("can be removed after a refusal or when nothing was sent", async () => {
    const [a, b] = await pair();
    const c = (await must(claim(cds, a.id, b.id))) as Claimed;
    await must(finish(cds, a.id, c.claim_id, "refused"));
    await must(cds.client.from("work_order_links").delete().eq("work_order_id", b.id));
  });

  it("refuses linking a work order that has its own invoice or is invoiced, naming it", async () => {
    const a = await order(shopA, "completed");
    const invoiced = await order(shopB, "completed");
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: invoiced.id, p_qb_invoice_id: `CMB${runId}o`, p_qb_invoice_number: `N${runId}o` }));
    const r = await cds.client.from("work_order_links").insert({ work_order_id: a.id, linked_work_order_id: invoiced.id });
    expect(r.error?.message).toBe(
      `WO-${invoiced.wo_number} already has QuickBooks invoice N${runId}o, so it cannot be linked: linked work orders share one customer invoice.`,
    );
    const early = await order(shopB, "in_process");
    await must(cds.client.rpc("cds_mark_invoiced", { p_work_order: early.id, p_qb_invoice_id: `CMB${runId}e`, p_qb_invoice_number: null }));
    expect((await cds.client.from("work_order_links").insert({ work_order_id: early.id, linked_work_order_id: a.id })).error?.message).toBe(
      `WO-${early.wo_number} already has QuickBooks invoice CMB${runId}e, so it cannot be linked: linked work orders share one customer invoice.`,
    );
    const manual = await order(shopB, "invoiced");
    expect((await cds.client.from("work_order_links").insert({ work_order_id: a.id, linked_work_order_id: manual.id })).error?.message).toBe(
      `WO-${manual.wo_number} is already invoiced, so it cannot be linked: linked work orders share one customer invoice.`,
    );
  });

  it("refuses a third work order in a pair, but lets CDS move a link to another order", async () => {
    const [a, b] = await pair();
    const c = await order(shopA);
    const third = await cds.client.from("work_order_links").insert({ work_order_id: c.id, linked_work_order_id: a.id });
    expect(third.error?.message).toBe(
      `WO-${a.wo_number} is already linked to WO-${b.wo_number}. One QuickBooks invoice covers two linked work orders: remove that link first.`,
    );
    // b -> a becomes b -> c (the same upsert the work order page sends).
    await must(cds.client.from("work_order_links").upsert({ work_order_id: b.id, linked_work_order_id: c.id }));
    // Setting the link the other way round as well changes nothing.
    await must(cds.client.from("work_order_links").upsert({ work_order_id: c.id, linked_work_order_id: b.id }));
  });

  it("does not stop deleting either work order", async () => {
    const [a, b] = await pair();
    await created(a, b, `CMB${runId}d`);
    await must(markLinked(cds, a.id, b.id, `CMB${runId}d`));
    await must(admin.from("profiles").update({ can_delete_work_orders: true }).eq("id", otherCds.id));
    await must(otherCds.client.rpc("cds_delete_work_order", { p_work_order: b.id }));
    expect(await must(admin.from("work_order_links").select("work_order_id").eq("work_order_id", b.id))).toEqual([]);
    expect((await internal(a.id)).qb_invoice_id).toBe(`CMB${runId}d`);
  });
});

describe("shops", () => {
  it("see only their own work order: not the other one, the claim, the link or the shared total", async () => {
    const [a, b] = await pair();
    await created(a, b, `CMB${runId}i`);
    await must(markLinked(cds, a.id, b.id, `CMB${runId}i`));
    const other = await loginA.client.from("work_orders").select("id").eq("id", b.id);
    expect(other.error ? [] : other.data).toEqual([]);
    for (const table of ["qbo_invoice_claims", "work_order_links", "work_order_internal"]) {
      const r = await loginA.client.from(table).select("*");
      expect(r.error ? [] : r.data, table).toEqual([]);
    }
    const own = (await must(loginA.client.from("work_orders").select("*").eq("id", a.id).single())) as Record<string, unknown>;
    expect(Object.keys(own).filter((k) => /qb_|total|link/.test(k))).toEqual([]);
    const events = (await must(loginA.client.from("work_order_events").select("message").eq("work_order_id", a.id))) as { message: string }[];
    expect(events.some((e) => e.message.includes(`WO-${b.wo_number}`))).toBe(false);
  });

  it("cannot claim, record or unlink the shared invoice", async () => {
    const [a, b] = await pair();
    expect((await claim(loginA, a.id, b.id)).error).not.toBeNull();
    expect((await markLinked(loginA, a.id, b.id, `CMB${runId}z`)).error).not.toBeNull();
    expect((await loginA.client.rpc("cds_mark_invoiced_linked", { p_work_order: a.id, p_linked: b.id, p_qb_invoice_id: "1", p_qb_invoice_number: null })).error).not.toBeNull();
    expect(await must(admin.from("qbo_invoice_claims").select("work_order_id").in("work_order_id", [a.id, b.id]))).toEqual([]);
  });
});
