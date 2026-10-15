/**
 * QuickBooks: the connection tokens are reachable by the service role only, the mappings
 * and customer part numbers are CDS only, and cds_mark_invoiced moves a work order from
 * Ready to Invoice to Invoiced exactly once.
 *
 * The real QuickBooks connection row (if any) is never written: the only write attempts
 * are calls that must be refused, made with arguments that would change nothing even if
 * they were allowed.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards,
 * so the suite can run against a local stack or a staging project.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shop: string; customer: string; item: string; mapIds: string[] };

let f: Fixture;
let cds: Login;
let shop: Login;

const LABEL = `QBO-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

/** A work order of this run with its internal row. */
async function workOrder(status: string, unit: string): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: f.customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: f.shop,
    status,
    unit_number: unit,
    requested_work: "Test cleaning",
    affiliate_invoice_ref: ["completed", "delivered", "ready_to_invoice", "invoiced"].includes(status) ? "INV-1" : null,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

beforeAll(async () => {
  const shopRow = await insertOne("affiliates", { short_code: `QS-${runId}`, display_name: `Shop QBO ${runId}` });
  const customer = await insertOne("customers", { code: `QC-${runId}`, name: `Customer QBO ${runId}` });
  const item = await insertOne("catalog_items", {
    sku: `QI-${runId}`,
    category: "part",
    name: "Test QuickBooks part",
    tax_class: "parts",
  });
  const cm = await insertOne("qbo_customer_map", { customer_id: customer.id, qbo_customer_id: "58", qbo_display_name: "QBO Customer" });
  const im = await insertOne("qbo_item_map", { catalog_item_id: item.id, qbo_item_id: "7", qbo_item_name: "QBO Item" });
  const alias = await insertOne("customer_item_aliases", {
    customer_id: customer.id,
    catalog_item_id: item.id,
    customer_part_number: `FS-${runId}`,
  });
  f = { shop: shopRow.id, customer: customer.id, item: item.id, mapIds: [cm.id, im.id, alias.id] };
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", f.shop);
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
  // Logins: their profile rows are in the change log too.
  const rowIds: string[] = [...(f?.mapIds ?? []), ...[cds?.id, shop?.id].filter((v): v is string => !!v)];

  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["catalog_items", "sku"],
      ["affiliates", "short_code"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
    const customers = await must(admin.from("customers").select("id").like("code", suffix));
    const ids = customers.map((r: { id: string }) => r.id);
    if (ids.length) {
      for (const table of ["qbo_customer_map", "customer_item_aliases"]) {
        rowIds.push(...(await must(admin.from(table).select("id").in("customer_id", ids))).map((r: { id: string }) => r.id));
      }
    }
    const items = await must(admin.from("catalog_items").select("id").like("sku", suffix));
    const itemIds = items.map((r: { id: string }) => r.id);
    if (itemIds.length) {
      rowIds.push(...(await must(admin.from("qbo_item_map").select("id").in("catalog_item_id", itemIds))).map((r: { id: string }) => r.id));
    }
  });
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  // Mappings and part numbers go with their customer and item (on delete cascade).
  await step("delete catalog items", () => must(admin.from("catalog_items").delete().like("sku", suffix)));
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));

  const head = { count: "exact" as const, head: true };
  const left: string[] = [];
  for (const [label, query] of [
    ["work orders", admin.from("work_orders").select("id", head).eq("location_label", LABEL)],
    ["catalog items", admin.from("catalog_items").select("id", head).like("sku", suffix)],
    ["customers", admin.from("customers").select("id", head).like("code", suffix)],
    ["shops", admin.from("affiliates").select("id", head).like("short_code", suffix)],
    ["customer part numbers", admin.from("customer_item_aliases").select("id", head).like("customer_part_number", `FS-${runId}`)],
    ["change log rows", admin.from("audit_log").select("id", head).in("row_id", rowIds.length ? rowIds : ["none"])],
  ] as const) {
    const { count, error } = await query;
    if (error) errors.push(`check ${label}: ${error.message}`);
    else if (count) left.push(`${count} ${label}`);
  }
  if (errors.length || left.length) {
    throw new Error(
      `cleanup of run ${runId} incomplete.` +
        (errors.length ? ` Failed steps: ${errors.join("; ")}.` : "") +
        (left.length ? ` Left in the database: ${left.join(", ")}.` : ""),
    );
  }
}, 120_000);

const MAP_TABLES = ["qbo_customer_map", "qbo_item_map", "customer_item_aliases"] as const;

describe("QuickBooks mappings and customer part numbers", () => {
  it("a shop reads nothing and cannot write", async () => {
    for (const table of MAP_TABLES) {
      const { data, error } = await shop.client.from(table).select("*").limit(5);
      expect(error ? [] : data, table).toEqual([]);
    }
    const { error } = await shop.client
      .from("customer_item_aliases")
      .insert({ customer_id: f.customer, catalog_item_id: f.item, customer_part_number: "X" });
    expect(error).not.toBeNull();
    await shop.client.from("qbo_item_map").update({ qbo_item_id: "999" }).eq("catalog_item_id", f.item);
    const row = await must(admin.from("qbo_item_map").select("qbo_item_id").eq("catalog_item_id", f.item).single());
    expect(row.qbo_item_id).toBe("7");
  });

  it("an anonymous caller reads nothing", async () => {
    for (const table of MAP_TABLES) {
      const { data, error } = await anon().from(table).select("*").limit(5);
      expect(error ? [] : data, table).toEqual([]);
    }
  });

  it("CDS reads and edits them, and edits are in the change log", async () => {
    for (const table of MAP_TABLES) {
      const rows = await must(cds.client.from(table).select("id").in("id", f.mapIds));
      expect(rows.length, table).toBe(1);
    }
    await must(cds.client.from("qbo_customer_map").update({ qbo_display_name: "QBO Customer 2" }).eq("customer_id", f.customer));
    const log = await must(
      admin.from("audit_log").select("action, actor_id").eq("table_name", "qbo_customer_map").eq("row_id", f.mapIds[0]),
    );
    expect(log).toContainEqual({ action: "update", actor_id: cds.id });
  });

  it("one part number per customer and item", async () => {
    const { error } = await cds.client
      .from("customer_item_aliases")
      .insert({ customer_id: f.customer, catalog_item_id: f.item, customer_part_number: "OTHER" });
    expect(error?.code).toBe("23505");
  });
});

describe("QuickBooks connection tokens", () => {
  const clients = (): [string, SupabaseClient][] => [
    ["anon", anon()],
    ["shop", shop.client],
    ["cds", cds.client],
  ];

  it("nobody but the service role can read the connection", async () => {
    for (const [who, client] of clients()) {
      const { error } = await client.rpc("qbo_get_connection");
      expect(error, who).not.toBeNull();
      const direct = await client.schema("private").from("qbo_connection").select("*");
      expect(direct.error, `${who} direct`).not.toBeNull();
    }
    const { error } = await admin.rpc("qbo_get_connection");
    expect(error).toBeNull();
  });

  it("nobody but the service role can write tokens (refused before running)", async () => {
    for (const [who, client] of clients()) {
      // Harmless even if it ran: no realm "none", and an environment the table rejects.
      const save = await client.rpc("qbo_save_connection", {
        p_environment: "invalid",
        p_realm_id: "none",
        p_company_name: null,
        p_ast_enabled: null,
        p_access_token: "x",
        p_access_token_expires_at: new Date().toISOString(),
        p_refresh_token: "x",
        p_refresh_token_expires_at: null,
        p_connected_by: null,
      });
      // 23514 would mean the function ran and only the table check stopped it.
      expect(save.error, `${who} save`).not.toBeNull();
      expect(save.error?.code, `${who} save`).not.toBe("23514");
      const tokens = await client.rpc("qbo_save_tokens", {
        p_realm_id: "none",
        p_previous_refresh_token: "none",
        p_access_token: "x",
        p_access_token_expires_at: new Date().toISOString(),
        p_refresh_token: "x",
        p_refresh_token_expires_at: null,
      });
      expect(tokens.error, `${who} tokens`).not.toBeNull();
    }
  });

  it("CDS sees whether QuickBooks is connected, without tokens; shops and anonymous callers do not", async () => {
    const { data, error } = await cds.client.rpc("qbo_connection_status");
    expect(error).toBeNull();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(
        ["ast_enabled", "company_name", "connected", "connected_at", "connected_by_name", "environment"].sort(),
      );
    }
    for (const client of [shop.client, anon()]) {
      const res = await client.rpc("qbo_connection_status");
      expect(res.error).not.toBeNull();
    }
  });
});

describe("cds_mark_invoiced", () => {
  const mark = (client: SupabaseClient, wo: string, id: string, number: string | null = null) =>
    client.rpc("cds_mark_invoiced", { p_work_order: wo, p_qb_invoice_id: id, p_qb_invoice_number: number });

  it("moves a Ready to Invoice order to Invoiced once and records the invoice and an event", async () => {
    const wo = await workOrder("ready_to_invoice", "QB-1");
    const id = `T${runId}1`;
    await must(mark(cds.client, wo, id, `N${runId}1`));

    const order = await must(admin.from("work_orders").select("status").eq("id", wo).single());
    expect(order.status).toBe("invoiced");
    const internal = await must(
      admin.from("work_order_internal").select("qb_invoice_id, qb_invoice_number, invoiced_at").eq("work_order_id", wo).single(),
    );
    expect(internal.qb_invoice_id).toBe(id);
    expect(internal.qb_invoice_number).toBe(`N${runId}1`);
    expect(internal.invoiced_at).not.toBeNull();
    const events = await must(
      admin.from("work_order_events").select("event_type, from_status, to_status, actor_id, shop_visible").eq("work_order_id", wo),
    );
    expect(events).toEqual([
      { event_type: "invoice", from_status: "ready_to_invoice", to_status: "invoiced", actor_id: cds.id, shop_visible: false },
    ]);

    const again = await mark(cds.client, wo, `T${runId}2`);
    expect(again.error?.message).toMatch(/Ready to Invoice/);
    const same = await mark(cds.client, wo, id);
    expect(same.error).not.toBeNull();
  });

  it("refuses an order that is not Ready to Invoice", async () => {
    for (const status of ["completed", "delivered", "cancelled"]) {
      const wo = await workOrder(status, `QB-${status}`);
      const { error } = await mark(cds.client, wo, `T${runId}${status}`);
      expect(error?.message, status).toMatch(/Ready to Invoice/);
      const order = await must(admin.from("work_orders").select("status").eq("id", wo).single());
      expect(order.status).toBe(status);
    }
  });

  it("needs an invoice id, and the same QuickBooks invoice cannot go on two orders", async () => {
    const a = await workOrder("ready_to_invoice", "QB-A");
    const blank = await mark(cds.client, a, " ");
    expect(blank.error).not.toBeNull();

    const b = await workOrder("ready_to_invoice", "QB-B");
    await must(mark(cds.client, a, `T${runId}dup`));
    const dup = await mark(cds.client, b, `T${runId}dup`);
    expect(dup.error).not.toBeNull();
    const order = await must(admin.from("work_orders").select("status").eq("id", b).single());
    expect(order.status).toBe("ready_to_invoice");
  });

  it("shops and anonymous callers cannot mark an order invoiced", async () => {
    const wo = await workOrder("ready_to_invoice", "QB-S");
    for (const client of [shop.client, anon()]) {
      const { error } = await mark(client, wo, `T${runId}shop`);
      expect(error).not.toBeNull();
    }
    const order = await must(admin.from("work_orders").select("status").eq("id", wo).single());
    expect(order.status).toBe("ready_to_invoice");
  });
});
