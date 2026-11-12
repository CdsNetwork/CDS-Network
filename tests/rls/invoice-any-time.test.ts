/**
 * Invoice any time (CDS, 2026-11-12; 20261112040000_invoice_any_time.sql).
 *
 * cds_mark_invoiced records the QuickBooks invoice at any status except cancelled and already
 * invoiced. A done order (completed, delivered, ready to invoice) moves to Invoiced as before;
 * any other order keeps its status, and shop_complete_work_order then moves it straight to
 * Invoiced (in-house orders too). Until then the order is locked like an invoiced one: no
 * customer line, tax, customer or location change, and no cancel. The shop keeps working.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shop: string; inHouse: string; customer: string; other: string; part: string; misc: string };

let f: Fixture;
let cds: Login;
let shop: Login;
let inHouseLogin: Login;

const LABEL = `IAT-${runId}`;
let seq = 0;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

/** A work order at the given status with one priced part line, ready for the shop to complete. */
async function workOrder(status: string, opts: { shop?: string; requestType?: string } = {}): Promise<{ id: string; wo_number: number }> {
  seq += 1;
  const done = ["completed", "delivered", "ready_to_invoice", "invoiced"].includes(status);
  const wo = await insertOne<{ id: string; wo_number: number }>("work_orders", {
    customer_id: f.customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: status === "pending_review" ? null : (opts.shop ?? f.shop),
    status,
    unit_number: `U-${seq}`,
    requested_work: "Test cleaning",
    request_type: opts.requestType ?? "service",
    affiliate_invoice_ref: done ? "INV-1" : null,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.part, qty: 1, origin: "cds_order" }));
  if ((opts.requestType ?? "service") === "service") {
    await must(
      admin.from("work_order_components").insert({
        work_order_id: wo.id,
        seq: 1,
        component_type: "EGR",
        manufacturer: "Test",
        part_number: `PN-${runId}`,
        serial_number: `SN-${runId}-${seq}`,
        result: "passed",
      }),
    );
  }
  return wo;
}

const mark = (client: Login, wo: string, id: string, number: string | null = null) =>
  client.client.rpc("cds_mark_invoiced", { p_work_order: wo, p_qb_invoice_id: id, p_qb_invoice_number: number });

const statusOf = async (wo: string) => (await must(admin.from("work_orders").select("status").eq("id", wo).single())).status as string;

beforeAll(async () => {
  const shopRow = await insertOne("affiliates", { short_code: `IAT-${runId}`, display_name: `Shop IAT ${runId}` });
  const inHouse = await must(admin.from("affiliates").select("id").eq("is_in_house", true));
  const customer = await insertOne("customers", { code: `IAT-${runId}`, name: `Customer IAT ${runId}` });
  const other = await insertOne("customers", { code: `IATO-${runId}`, name: `Other IAT ${runId}` });
  const part = await insertOne("catalog_items", { sku: `IATP-${runId}`, category: "part", name: "Test part", tax_class: "parts" });
  const misc = await insertOne("catalog_items", {
    sku: `IATM-${runId}`,
    category: "part",
    name: "Test misc",
    tax_class: "parts",
    shop_selectable: false,
    price_per_line: true,
  });
  await must(admin.from("sell_prices").insert({ catalog_item_id: part.id, market: "US", amount: 30, effective_from: "2026-01-01" }));
  await must(admin.from("shop_rates").insert({ catalog_item_id: part.id, market: "US", amount: 20, effective_from: "2026-01-01" }));
  f = { shop: shopRow.id, inHouse: inHouse[0].id, customer: customer.id, other: other.id, part: part.id, misc: misc.id };
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", f.shop);
  inHouseLogin = await createLogin("shop", f.inHouse);
}, 120_000);

afterAll(async () => {
  const errors: string[] = [];
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const suffix = `%-${runId}`;
  const rowIds: string[] = [cds?.id, shop?.id, inHouseLogin?.id].filter((v): v is string => !!v);
  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["catalog_items", "sku"],
      ["affiliates", "short_code"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
    const wos = await must(admin.from("work_orders").select("id").eq("location_label", LABEL));
    rowIds.push(...wos.map((r: { id: string }) => r.id));
  });
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete catalog items", () => must(admin.from("catalog_items").delete().like("sku", suffix)));
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("cds_mark_invoiced at any status", () => {
  it("records the invoice on an order the shop is still working on and keeps its status", async () => {
    const wo = await workOrder("in_process");
    await must(mark(cds, wo.id, `IAT${runId}a`, `N${runId}a`));
    expect(await statusOf(wo.id)).toBe("in_process");
    const internal = await must(
      admin.from("work_order_internal").select("qb_invoice_id, qb_invoice_number, invoiced_at").eq("work_order_id", wo.id).single(),
    );
    expect(internal).toMatchObject({ qb_invoice_id: `IAT${runId}a`, qb_invoice_number: `N${runId}a` });
    expect(internal.invoiced_at).not.toBeNull();
    const events = await must(
      admin.from("work_order_events").select("event_type, from_status, to_status, shop_visible").eq("work_order_id", wo.id),
    );
    expect(events).toEqual([{ event_type: "invoice", from_status: "in_process", to_status: "in_process", shop_visible: false }]);
  });

  it("moves a completed or delivered order straight to Invoiced", async () => {
    for (const status of ["completed", "delivered"]) {
      const wo = await workOrder(status);
      await must(mark(cds, wo.id, `IAT${runId}${status}`));
      expect(await statusOf(wo.id), status).toBe("invoiced");
    }
  });

  it("refuses a cancelled order, and a second invoice on a pre-invoiced order", async () => {
    const cancelled = await workOrder("cancelled");
    const c = await mark(cds, cancelled.id, `IAT${runId}c`);
    expect(c.error?.message).toMatch(/cancelled/i);

    const wo = await workOrder("accepted");
    await must(mark(cds, wo.id, `IAT${runId}b`));
    const again = await mark(cds, wo.id, `IAT${runId}b2`);
    expect(again.error?.message).toMatch(/already has QuickBooks invoice/);
  });

  it("shops cannot mark their order invoiced", async () => {
    const wo = await workOrder("in_process");
    const { error } = await shop.client.rpc("cds_mark_invoiced", { p_work_order: wo.id, p_qb_invoice_id: `IAT${runId}s`, p_qb_invoice_number: null });
    expect(error).not.toBeNull();
    const internal = await must(admin.from("work_order_internal").select("qb_invoice_id").eq("work_order_id", wo.id).single());
    expect(internal.qb_invoice_id).toBeNull();
  });
});

describe("completing an order", () => {
  it("a pre-invoiced order goes straight to Invoiced when the shop completes it", async () => {
    const wo = await workOrder("in_process");
    await must(mark(cds, wo.id, `IAT${runId}d`));
    await must(shop.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "SHOP-77" }));
    const after = await must(admin.from("work_orders").select("status, affiliate_invoice_ref, completed_at").eq("id", wo.id).single());
    expect(after).toMatchObject({ status: "invoiced", affiliate_invoice_ref: "SHOP-77" });
    expect(after.completed_at).not.toBeNull();
    const events = await must(
      admin.from("work_order_events").select("event_type, to_status, shop_visible").eq("work_order_id", wo.id).order("id"),
    );
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["invoice", "complete", "invoice"]);
    expect(events[1]).toMatchObject({ event_type: "complete", shop_visible: true });
    expect(events[2]).toMatchObject({ to_status: "invoiced", shop_visible: false });
  });

  it("an order without a QuickBooks invoice still goes to Completed", async () => {
    const wo = await workOrder("in_process");
    await must(shop.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "SHOP-78" }));
    expect(await statusOf(wo.id)).toBe("completed");
  });

  it("a pre-invoiced in-house order goes to Invoiced too", async () => {
    const wo = await workOrder("accepted", { shop: f.inHouse, requestType: "parts_only" });
    await must(mark(cds, wo.id, `IAT${runId}h`));
    await must(inHouseLogin.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "" }));
    const after = await must(admin.from("work_orders").select("status, affiliate_invoice_ref").eq("id", wo.id).single());
    expect(after).toEqual({ status: "invoiced", affiliate_invoice_ref: `IN-HOUSE-${wo.wo_number}` });
  });
});

describe("the lock on a pre-invoiced order the shop is still working on", () => {
  let wo: { id: string; wo_number: number };

  beforeAll(async () => {
    wo = await workOrder("in_process");
    await must(mark(cds, wo.id, `IAT${runId}L`));
  });

  it("CDS cannot add or remove customer lines", async () => {
    const add = await cds.client.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.part, qty: 1, origin: "cds_order" });
    expect(add.error?.message).toMatch(/invoiced/i);
    const del = await cds.client.from("work_order_lines").delete().eq("work_order_id", wo.id).select("id");
    expect(del.error?.message).toMatch(/invoiced/i);
    const misc = await cds.client.rpc("cds_add_pass_through_line", {
      p_work_order: wo.id,
      p_catalog_item: f.misc,
      p_description: "Bolts",
      p_amount: 12,
    });
    expect(misc.error?.message).toMatch(/invoiced/i);
    const count = await admin.from("work_order_lines").select("id", { count: "exact", head: true }).eq("work_order_id", wo.id);
    expect(count.count).toBe(1);
  });

  it("the shop cannot add a part", async () => {
    const { error } = await shop.client.rpc("shop_add_part", { p_work_order: wo.id, p_catalog_item: f.part, p_qty: 1 });
    expect(error?.message).toMatch(/invoiced/i);
  });

  it("CDS cannot approve extra work that would add a line", async () => {
    await must(
      shop.client.rpc("shop_request_authorization", {
        p_work_order: wo.id,
        p_catalog_item: f.part,
        p_qty: 1,
        p_note: "Needs a new part",
      }),
    );
    const req = await must(admin.from("authorization_requests").select("id").eq("work_order_id", wo.id).single());
    const approve = await cds.client.rpc("cds_decide_authorization", {
      p_request: req.id,
      p_approve: true,
      p_decision_note: null,
      p_customer_approved_by: "Fleet manager",
    });
    expect(approve.error?.message).toMatch(/invoiced/i);
    await must(cds.client.rpc("cds_decide_authorization", { p_request: req.id, p_approve: false, p_decision_note: "Invoiced", p_customer_approved_by: null }));
  });

  it("tax, customer and location cannot change, and the order cannot be cancelled", async () => {
    const tax = await cds.client.from("work_order_internal").update({ tax_rate: 9.5 }).eq("work_order_id", wo.id);
    expect(tax.error?.message).toMatch(/invoiced/i);
    const customer = await cds.client.from("work_orders").update({ customer_id: f.other }).eq("id", wo.id);
    expect(customer.error?.message).toMatch(/invoiced/i);
    const cancel = await cds.client.rpc("cds_set_status", { p_work_order: wo.id, p_status: "cancelled", p_note: null });
    expect(cancel.error).not.toBeNull();
    const after = await must(admin.from("work_orders").select("status, customer_id").eq("id", wo.id).single());
    expect(after).toEqual({ status: "in_process", customer_id: f.customer });
  });

  it("the shop keeps working: progress, results and completion", async () => {
    const comp = await must(admin.from("work_order_components").select("id").eq("work_order_id", wo.id).single());
    await must(
      shop.client.rpc("shop_save_component", {
        p_work_order: wo.id,
        p_component: comp.id,
        p_type: "EGR",
        p_manufacturer: "Test",
        p_part_number: `PN-${runId}`,
        p_serial_number: `SN-${runId}-L`,
        p_dp_before: null,
        p_dp_after: null,
        p_weight_before_g: null,
        p_weight_after_g: null,
        p_result: "passed",
        p_result_note: "Fine",
      }),
    );
    await must(shop.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "SHOP-L" }));
    expect(await statusOf(wo.id)).toBe("invoiced");
  });
});
