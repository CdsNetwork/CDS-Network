/**
 * Customer items (First Student's "AM" gaskets and clamps), items priced on the order
 * (reconditioned filters) and shop rates entered on the line
 * (20261111090000_customer_items_and_line_prices.sql).
 *
 * A gasket or clamp line on a First Student order becomes its AM item whoever adds it (CDS,
 * the shop, an approved extra work request); on any other customer's order it stays the
 * regular item, and an AM item becomes the regular one. The AM item has the customer's own
 * price and no shop rate (TBD) until CDS enters one; until then the order's financials say
 * TBD instead of counting the line as 0.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = {
  shop: string;
  fs: string;
  other: string;
  gasket: string;
  gasketAm: string;
  clamp: string;
  clampAm: string;
  recon: string;
  misc: string;
};

let f: Fixture;
let cds: Login;
let shop: Login;

const LABEL = `CI-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(customer: string, status: string, unit: string): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
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

type LineRow = { id: string; catalog_item_id: string; shop_unit_rate: number | null; shop_rate_source: string };

async function lines(wo: string): Promise<(LineRow & { price: number | null })[]> {
  const rows = await must(
    admin
      .from("work_order_lines")
      .select("id, catalog_item_id, shop_unit_rate, shop_rate_source, work_order_line_pricing(customer_unit_price)")
      .eq("work_order_id", wo)
      .order("created_at"),
  );
  return (rows as (LineRow & { work_order_line_pricing: { customer_unit_price: number } | { customer_unit_price: number }[] | null })[]).map(
    ({ work_order_line_pricing: p, ...l }) => {
      const one = Array.isArray(p) ? p[0] : p;
      return { ...l, price: one ? Number(one.customer_unit_price) : null };
    },
  );
}

const cdsAdd = (wo: string, item: string, qty = 1) =>
  must(cds.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: item, qty, origin: "cds_order" }));

const financials = (wo: string) =>
  must(
    cds.client
      .from("work_order_financials")
      .select("customer_subtotal, shop_subtotal, margin_before_shipping, supplier_cost_tbd")
      .eq("work_order_id", wo)
      .single(),
  );

beforeAll(async () => {
  const shopRow = await insertOne("affiliates", { short_code: `CI-${runId}`, display_name: `Shop CI ${runId}` });
  const fs = await insertOne("customers", { code: `CIFS-${runId}`, name: `First Student CI ${runId}` });
  const other = await insertOne("customers", { code: `CIOT-${runId}`, name: `Other CI ${runId}` });
  const item = (sku: string, category: string, extra: Record<string, unknown> = {}) =>
    insertOne("catalog_items", { sku: `${sku}-${runId}`, category, name: `Test ${sku}`, tax_class: "parts", ...extra });
  const gasket = await item("CIG", "gasket");
  const clamp = await item("CICL", "clamp");
  const gasketAm = await item("CIGAM", "gasket", { shop_selectable: false, variant_of: gasket.id, variant_customer_id: fs.id });
  const clampAm = await item("CICLAM", "clamp", { shop_selectable: false, variant_of: clamp.id, variant_customer_id: fs.id });
  const recon = await item("CIRECON", "part", { shop_selectable: false, price_per_line: true, pass_through: false });
  const misc = await item("CIMISC", "part", { shop_selectable: false, price_per_line: true });
  const today = "2026-01-01";
  for (const [id, fleet, rate] of [
    [gasket.id, 30, 20],
    [clamp.id, 45, 40.79],
  ] as const) {
    await must(admin.from("sell_prices").insert({ catalog_item_id: id, market: "US", amount: fleet, effective_from: today }));
    await must(admin.from("shop_rates").insert({ catalog_item_id: id, market: "US", amount: rate, effective_from: today }));
  }
  for (const [id, amount] of [
    [gasketAm.id, 21.77],
    [clampAm.id, 30],
  ] as const) {
    await must(
      admin.from("customer_price_overrides").insert({ customer_id: fs.id, catalog_item_id: id, market: "US", amount, effective_from: today }),
    );
  }
  f = {
    shop: shopRow.id,
    fs: fs.id,
    other: other.id,
    gasket: gasket.id,
    gasketAm: gasketAm.id,
    clamp: clamp.id,
    clampAm: clampAm.id,
    recon: recon.id,
    misc: misc.id,
  };
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
  const rowIds: string[] = [cds?.id, shop?.id].filter((v): v is string => !!v);
  await step("find fixture rows", async () => {
    for (const [table, column] of [
      ["customers", "code"],
      ["catalog_items", "sku"],
      ["affiliates", "short_code"],
    ] as const) {
      rowIds.push(...(await must(admin.from(table).select("id").like(column, suffix))).map((r: { id: string }) => r.id));
    }
    const wos = await must(admin.from("work_orders").select("id").eq("location_label", LABEL));
    const woIds = wos.map((r: { id: string }) => r.id);
    rowIds.push(...woIds);
    if (woIds.length) {
      rowIds.push(...(await must(admin.from("work_order_lines").select("id").in("work_order_id", woIds))).map((r: { id: string }) => r.id));
    }
  });
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  // Customer items first: they point at the regular items.
  await step("delete customer items", () => must(admin.from("catalog_items").delete().like("sku", suffix).not("variant_of", "is", null)));
  await step("delete catalog items", () => must(admin.from("catalog_items").delete().like("sku", suffix)));
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("First Student AM items", () => {
  it("a gasket or clamp CDS adds on a First Student order becomes the AM item, at FS's price with the shop rate TBD", async () => {
    const wo = await workOrder(f.fs, "in_process", "CI-1");
    await cdsAdd(wo, f.gasket, 2);
    await cdsAdd(wo, f.clamp);
    const got = await lines(wo);
    expect(got.map((l) => [l.catalog_item_id, l.price, l.shop_unit_rate])).toEqual([
      [f.gasketAm, 21.77, null],
      [f.clampAm, 30, null],
    ]);
  });

  it("on another customer's order the regular item stays, and an AM item becomes the regular one", async () => {
    const wo = await workOrder(f.other, "in_process", "CI-2");
    await cdsAdd(wo, f.gasket);
    await cdsAdd(wo, f.clampAm);
    const got = await lines(wo);
    expect(got.map((l) => [l.catalog_item_id, l.price, l.shop_unit_rate])).toEqual([
      [f.gasket, 30, 20],
      [f.clamp, 45, 40.79],
    ]);
  });

  it("a part the shop adds, and approved extra work, become the AM item on a First Student order", async () => {
    const wo = await workOrder(f.fs, "in_process", "CI-3");
    await must(shop.client.rpc("shop_add_part", { p_work_order: wo, p_catalog_item: f.clamp, p_qty: 1 }));
    const req = await must(
      shop.client.rpc("shop_request_authorization", { p_work_order: wo, p_catalog_item: f.gasket, p_qty: 1, p_note: "Gasket torn" }),
    );
    await must(
      cds.client.rpc("cds_decide_authorization", {
        p_request: req,
        p_approve: true,
        p_decision_note: null,
        p_customer_approved_by: "Fleet manager",
      }),
    );
    const got = await lines(wo);
    expect(got.map((l) => l.catalog_item_id).sort()).toEqual([f.clampAm, f.gasketAm].sort());
    // The shop sees the AM line with no rate, never the customer price.
    const seen = await must(shop.client.from("work_order_lines").select("catalog_item_id, shop_unit_rate").eq("work_order_id", wo));
    expect(seen).toHaveLength(2);
    expect(seen.every((l: { shop_unit_rate: number | null }) => l.shop_unit_rate === null)).toBe(true);
    const pricing = await shop.client.from("work_order_line_pricing").select("*").eq("work_order_id", wo);
    expect(pricing.error ? [] : pricing.data).toEqual([]);
  });

  it("a shop cannot add the AM item itself", async () => {
    const wo = await workOrder(f.fs, "in_process", "CI-4");
    const { error } = await shop.client.rpc("shop_add_part", { p_work_order: wo, p_catalog_item: f.gasketAm, p_qty: 1 });
    expect(error).not.toBeNull();
  });

  it("an inactive AM item is not used", async () => {
    await must(admin.from("catalog_items").update({ active: false }).eq("id", f.clampAm));
    try {
      const wo = await workOrder(f.fs, "in_process", "CI-5");
      await cdsAdd(wo, f.clamp);
      expect((await lines(wo)).map((l) => l.catalog_item_id)).toEqual([f.clamp]);
    } finally {
      await must(admin.from("catalog_items").update({ active: true }).eq("id", f.clampAm));
    }
  });
});

describe("Shop rate TBD and entered on the line", () => {
  it("the financials say TBD until CDS enters the rate, then count it", async () => {
    const wo = await workOrder(f.fs, "in_process", "CI-6");
    await cdsAdd(wo, f.clamp, 2);
    expect(await financials(wo)).toEqual({ customer_subtotal: 60, shop_subtotal: 0, margin_before_shipping: 60, supplier_cost_tbd: true });

    const [line] = await lines(wo);
    await must(admin.from("work_orders").update({ status: "completed", affiliate_invoice_ref: "INV-1" }).eq("id", wo));
    await must(cds.client.rpc("cds_set_line_shop_rate", { p_line: line.id, p_amount: 25.5 }));
    expect(await financials(wo)).toEqual({ customer_subtotal: 60, shop_subtotal: 51, margin_before_shipping: 9, supplier_cost_tbd: false });
    const after = await lines(wo);
    expect(after[0]).toMatchObject({ shop_unit_rate: 25.5, shop_rate_source: "manual" });
    // A rate CDS entered can be corrected.
    await must(cds.client.rpc("cds_set_line_shop_rate", { p_line: line.id, p_amount: 24 }));
    expect((await lines(wo))[0].shop_unit_rate).toBe(24);
    const events = await must(admin.from("work_order_events").select("event_type, message").eq("work_order_id", wo).eq("event_type", "line_rate_set"));
    expect(events).toHaveLength(2);
  });

  it("only CDS sets it, never on a price-list rate, Misc. hardware or an invoiced order, and only dollars and cents", async () => {
    const wo = await workOrder(f.other, "in_process", "CI-7");
    await cdsAdd(wo, f.gasket);
    const fsWo = await workOrder(f.fs, "in_process", "CI-7FS");
    await cdsAdd(fsWo, f.gasket);
    const [priced] = await lines(wo);
    const [tbd] = await lines(fsWo);

    for (const client of [shop.client, anon()]) {
      const { error } = await client.rpc("cds_set_line_shop_rate", { p_line: tbd.id, p_amount: 5 });
      expect(error).not.toBeNull();
    }
    expect((await cds.client.rpc("cds_set_line_shop_rate", { p_line: priced.id, p_amount: 5 })).error?.message).toMatch(/price list/);
    for (const amount of [-1, 1.234, 100000]) {
      expect((await cds.client.rpc("cds_set_line_shop_rate", { p_line: tbd.id, p_amount: amount })).error, String(amount)).not.toBeNull();
    }
    const miscId = (await must(
      cds.client.rpc("cds_add_pass_through_line", { p_work_order: fsWo, p_catalog_item: f.misc, p_description: "Bolts", p_amount: 4 }),
    )) as string;
    expect((await cds.client.rpc("cds_set_line_shop_rate", { p_line: miscId, p_amount: 5 })).error?.message).toMatch(/remove the line/);

    await must(admin.from("work_orders").update({ status: "invoiced", affiliate_invoice_ref: "INV-1" }).eq("id", fsWo));
    expect((await cds.client.rpc("cds_set_line_shop_rate", { p_line: tbd.id, p_amount: 5 })).error?.message).toMatch(/invoiced or cancelled/);
    expect((await lines(fsWo)).find((l) => l.id === tbd.id)?.shop_unit_rate).toBeNull();
  });
});

describe("Items priced on the order", () => {
  it("CDS adds one with the customer price; the shop rate is TBD until entered", async () => {
    const wo = await workOrder(f.other, "in_process", "CI-8");
    const id = (await must(
      cds.client.rpc("cds_add_pass_through_line", { p_work_order: wo, p_catalog_item: f.recon, p_description: " ", p_amount: 625 }),
    )) as string;
    const line = await must(admin.from("work_order_lines").select("qty, shop_unit_rate, description").eq("id", id).single());
    expect(line).toEqual({ qty: 1, shop_unit_rate: null, description: null });
    const pricing = await must(admin.from("work_order_line_pricing").select("customer_unit_price, price_source").eq("line_id", id).single());
    expect(pricing).toEqual({ customer_unit_price: 625, price_source: "manual" });
    expect((await financials(wo)).supplier_cost_tbd).toBe(true);

    await must(cds.client.rpc("cds_set_line_shop_rate", { p_line: id, p_amount: 450 }));
    expect(await financials(wo)).toEqual({ customer_subtotal: 625, shop_subtotal: 450, margin_before_shipping: 175, supplier_cost_tbd: false });
  });

  it("is never added without the price, by a shop, or as an ordinary line", async () => {
    const wo = await workOrder(f.other, "in_process", "CI-9");
    const direct = await cds.client.from("work_order_lines").insert({ work_order_id: wo, catalog_item_id: f.recon, qty: 1 });
    expect(direct.error?.message).toMatch(/customer price/);
    const part = await shop.client.rpc("shop_add_part", { p_work_order: wo, p_catalog_item: f.recon, p_qty: 1 });
    expect(part.error).not.toBeNull();
    const byShop = await shop.client.rpc("cds_add_pass_through_line", {
      p_work_order: wo,
      p_catalog_item: f.recon,
      p_description: null,
      p_amount: 625,
    });
    expect(byShop.error).not.toBeNull();
    const noPrice = await cds.client.rpc("cds_add_pass_through_line", { p_work_order: wo, p_catalog_item: f.recon, p_description: null, p_amount: 0 });
    expect(noPrice.error?.message).toMatch(/customer price/);
    expect(await must(admin.from("work_order_lines").select("id").eq("work_order_id", wo))).toEqual([]);
  });

  it("Misc. hardware still needs a description and pays the shop the same amount", async () => {
    const wo = await workOrder(f.other, "in_process", "CI-10");
    const blank = await cds.client.rpc("cds_add_pass_through_line", { p_work_order: wo, p_catalog_item: f.misc, p_description: "", p_amount: 5 });
    expect(blank.error?.message).toMatch(/description/);
    const id = (await must(
      cds.client.rpc("cds_add_pass_through_line", { p_work_order: wo, p_catalog_item: f.misc, p_description: "Bolts", p_amount: 5 }),
    )) as string;
    const line = await must(admin.from("work_order_lines").select("shop_unit_rate, shop_rate_source").eq("id", id).single());
    expect(line).toEqual({ shop_unit_rate: 5, shop_rate_source: "manual" });
  });
});
