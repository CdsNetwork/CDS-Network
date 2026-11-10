/**
 * Shop rates for one customer (20261110020000_shop_rates_per_customer.sql).
 *
 * GESi replacement filters pay the shop one amount on First Student orders and another on
 * every other order. The rate snapshotted on a work order line (private.snapshot_shop_rate,
 * private.resnapshot_on_reassign, both through private.shop_rate_pick) takes the most
 * specific rate in effect: shop and customer > customer > shop > default.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Row = { id: string };

/** Today's date in California, computed independently of the app code. */
function pacificToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function insertOne<T extends Row>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const f = {} as {
  shopA: string;
  shopB: string;
  shopC: string;
  firstStudent: string;
  ryder: string;
  gesi: string;
  gesiEnded: string;
  gesiSet: string;
};
let cds: Login;
let shopA: Login;

beforeAll(async () => {
  f.shopA = (await insertOne("affiliates", { short_code: `SRA-${runId}`, display_name: `Shop SRA ${runId}` })).id;
  f.shopB = (await insertOne("affiliates", { short_code: `SRB-${runId}`, display_name: `Shop SRB ${runId}` })).id;
  f.shopC = (await insertOne("affiliates", { short_code: `SRC-${runId}`, display_name: `Shop SRC ${runId}` })).id;
  f.firstStudent = (await insertOne("customers", { code: `SRFS-${runId}`, name: `First Student SR ${runId}` })).id;
  f.ryder = (await insertOne("customers", { code: `SRRY-${runId}`, name: `Ryder SR ${runId}` })).id;
  const item = (sku: string) =>
    insertOne("catalog_items", { sku: `${sku}-${runId}`, category: "part", name: "Test GESi filter", tax_class: "parts" });
  f.gesi = (await item("CDS-DPF-GESI-SR")).id;
  f.gesiEnded = (await item("CDS-DPF-GESI-SRE")).id;
  f.gesiSet = (await item("CDS-DPF-GESI-SRS")).id;

  const today = pacificToday();
  const from = "2026-01-01";
  await must(
    admin.from("shop_rates").insert([
      { catalog_item_id: f.gesi, amount: 100, effective_from: from },
      { catalog_item_id: f.gesi, customer_id: f.firstStudent, amount: 150, effective_from: from },
      // Starts tomorrow: not in effect yet.
      { catalog_item_id: f.gesi, customer_id: f.firstStudent, amount: 999, effective_from: nextDay(today) },
      // Ended long ago.
      { catalog_item_id: f.gesi, customer_id: f.firstStudent, amount: 888, effective_from: "2025-01-01", effective_to: from },
      { catalog_item_id: f.gesi, affiliate_id: f.shopA, customer_id: f.firstStudent, amount: 170, effective_from: from },
      { catalog_item_id: f.gesi, affiliate_id: f.shopB, amount: 120, effective_from: from },
      // Ends today: no longer in effect today.
      { catalog_item_id: f.gesiEnded, amount: 50, effective_from: from },
      { catalog_item_id: f.gesiEnded, customer_id: f.firstStudent, amount: 75, effective_from: from, effective_to: today },
    ]),
  );
  await must(
    admin.from("sell_prices").insert([
      { catalog_item_id: f.gesi, amount: 400, effective_from: from },
      { catalog_item_id: f.gesiEnded, amount: 400, effective_from: from },
      { catalog_item_id: f.gesiSet, amount: 400, effective_from: from },
    ]),
  );
  await must(
    admin
      .from("customer_price_overrides")
      .insert({ customer_id: f.firstStudent, catalog_item_id: f.gesi, amount: 380, effective_from: from }),
  );
  cds = await createLogin("cds", null);
  shopA = await createLogin("shop", f.shopA);
});

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
  const rowIds: string[] = [];
  await step("find fixture rows", async () => {
    const ids = async (table: string, column: string) =>
      (await must(admin.from(table).select("id").like(column, suffix))).map((r: Row) => r.id);
    const itemIds = await ids("catalog_items", "sku");
    rowIds.push(...itemIds, ...(await ids("customers", "code")), ...(await ids("affiliates", "short_code")));
    if (itemIds.length) {
      for (const table of ["shop_rates", "sell_prices", "customer_price_overrides"]) {
        rowIds.push(...(await must(admin.from(table).select("id").in("catalog_item_id", itemIds))).map((r: Row) => r.id));
      }
    }
  });
  await step("delete logins", () => deleteLogins());
  await step("delete work orders", () => must(admin.from("work_orders").delete().in("customer_id", [f.firstStudent, f.ryder])));
  await step("delete catalog items", () => must(admin.from("catalog_items").delete().like("sku", suffix)));
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));

  const head = { count: "exact" as const, head: true };
  const left: string[] = [];
  for (const [label, query] of [
    ["catalog items", admin.from("catalog_items").select("id", head).like("sku", suffix)],
    ["customers", admin.from("customers").select("id", head).like("code", suffix)],
    ["shops", admin.from("affiliates").select("id", head).like("short_code", suffix)],
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
});

let unit = 0;
async function newWo(shop: string, customer: string): Promise<string> {
  unit += 1;
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: `TEST-${runId}`,
    fulfillment: "shipping",
    affiliate_id: shop,
    status: "accepted",
    unit_number: `SR-${unit}`,
    requested_work: "Test GESi filter",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

async function lineRate(shop: string, customer: string, item = f.gesi) {
  const wo = await newWo(shop, customer);
  const line = await must(
    admin
      .from("work_order_lines")
      .insert({ work_order_id: wo, catalog_item_id: item, qty: 1 })
      .select("id, shop_unit_rate, shop_rate_source")
      .single(),
  );
  return { wo, id: line.id as string, rate: Number(line.shop_unit_rate), source: line.shop_rate_source as string };
}

describe("a new line takes the most specific shop rate in effect", () => {
  it("a customer's rate beats the default (First Student order, shop without own rates)", async () => {
    expect(await lineRate(f.shopC, f.firstStudent)).toMatchObject({ rate: 150, source: "customer" });
  });

  it("other customers' orders keep the default", async () => {
    expect(await lineRate(f.shopC, f.ryder)).toMatchObject({ rate: 100, source: "default" });
  });

  it("a rate for this shop and this customer beats the customer's rate", async () => {
    expect(await lineRate(f.shopA, f.firstStudent)).toMatchObject({ rate: 170, source: "shop" });
  });

  it("a shop's rate for this customer does not apply to other customers", async () => {
    expect(await lineRate(f.shopA, f.ryder)).toMatchObject({ rate: 100, source: "default" });
  });

  it("the customer's rate beats a shop's own rate for any customer", async () => {
    expect(await lineRate(f.shopB, f.firstStudent)).toMatchObject({ rate: 150, source: "customer" });
  });

  it("a shop's own rate still beats the default on other customers' orders", async () => {
    expect(await lineRate(f.shopB, f.ryder)).toMatchObject({ rate: 120, source: "shop" });
  });

  it("respects start and end dates: a rate that ended today or long ago, or starts tomorrow, does not apply", async () => {
    // gesi: the 999 row starts tomorrow and the 888 row ended on 2026-01-01; 150 applies.
    expect(await lineRate(f.shopC, f.firstStudent)).toMatchObject({ rate: 150 });
    // gesiEnded: the customer's 75 ends today, so the default 50 applies.
    expect(await lineRate(f.shopC, f.firstStudent, f.gesiEnded)).toMatchObject({ rate: 50, source: "default" });
  });
});

describe("moving an order to another shop re-snapshots with the order's customer", () => {
  it("customer rate, then the new shop's rate for the customer, then back to the customer rate", async () => {
    const line = await lineRate(f.shopC, f.firstStudent);
    expect(line).toMatchObject({ rate: 150, source: "customer" });
    const read = () => must(admin.from("work_order_lines").select("shop_unit_rate, shop_rate_source").eq("id", line.id).single());

    await must(cds.client.from("work_orders").update({ affiliate_id: f.shopA }).eq("id", line.wo));
    expect(await read()).toEqual({ shop_unit_rate: 170, shop_rate_source: "shop" });

    // Shop B has only an any-customer rate, which loses to the customer's rate.
    await must(cds.client.from("work_orders").update({ affiliate_id: f.shopB }).eq("id", line.wo));
    expect(await read()).toEqual({ shop_unit_rate: 150, shop_rate_source: "customer" });
  });

  it("on another customer's order the new shop's own rate applies, as before", async () => {
    const line = await lineRate(f.shopC, f.ryder);
    await must(cds.client.from("work_orders").update({ affiliate_id: f.shopB }).eq("id", line.wo));
    const after = await must(admin.from("work_order_lines").select("shop_unit_rate, shop_rate_source").eq("id", line.id).single());
    expect(after).toEqual({ shop_unit_rate: 120, shop_rate_source: "shop" });
  });
});

describe("shop login", () => {
  it("reads default and own rows (with or without a customer), never another shop's", async () => {
    const rows = await must(
      shopA.client.from("shop_rates").select("affiliate_id, customer_id, amount").eq("catalog_item_id", f.gesi),
    );
    const seen = (rows as { affiliate_id: string | null; amount: number }[])
      .map((r) => Number(r.amount))
      .sort((a, b) => a - b);
    expect(seen).toEqual([100, 150, 170, 888, 999]);
    expect(rows.some((r: { affiliate_id: string | null }) => r.affiliate_id === f.shopB)).toBe(false);
  });

  it("still cannot read customer prices", async () => {
    const line = await lineRate(f.shopA, f.firstStudent);
    expect(await must(shopA.client.from("sell_prices").select("id").eq("catalog_item_id", f.gesi))).toEqual([]);
    expect(await must(shopA.client.from("customer_price_overrides").select("id").eq("catalog_item_id", f.gesi))).toEqual([]);
    expect(await must(shopA.client.from("work_order_line_pricing").select("line_id").eq("line_id", line.id))).toEqual([]);
  });

  it("cannot add or change a rate for a customer", async () => {
    const insert = await shopA.client
      .from("shop_rates")
      .insert({ catalog_item_id: f.gesi, affiliate_id: f.shopA, customer_id: f.ryder, amount: 9999 });
    expect(insert.error).not.toBeNull();
    await shopA.client.from("shop_rates").update({ amount: 9999 }).eq("catalog_item_id", f.gesi);
    const max = await must(admin.from("shop_rates").select("amount").eq("catalog_item_id", f.gesi));
    expect(Math.max(...max.map((r: { amount: number }) => Number(r.amount)))).toBe(999);
    const rpc = await shopA.client.rpc("cds_set_price", {
      p_kind: "shop_rate",
      p_catalog_item: f.gesi,
      p_customer: f.ryder,
      p_amount: 1,
    });
    expect(rpc.error).not.toBeNull();
  });
});

describe("cds_set_price for one customer", () => {
  it("sets and clears a customer's rate without touching the default", async () => {
    const set = (customer: string | null, amount: number | null) =>
      must(cds.client.rpc("cds_set_price", { p_kind: "shop_rate", p_catalog_item: f.gesiSet, p_customer: customer, p_amount: amount }));
    const rows = async () =>
      (await must(admin.from("shop_rates").select("customer_id, amount").eq("catalog_item_id", f.gesiSet).order("amount")))
        .map((r: { customer_id: string | null; amount: number }) => [r.customer_id, Number(r.amount)]);

    await set(null, 100);
    await set(f.firstStudent, 150);
    expect(await rows()).toEqual([
      [null, 100],
      [f.firstStudent, 150],
    ]);
    await set(null, 110);
    await set(f.firstStudent, 160);
    expect(await rows()).toEqual([
      [null, 110],
      [f.firstStudent, 160],
    ]);
    expect(await lineRate(f.shopC, f.firstStudent, f.gesiSet)).toMatchObject({ rate: 160, source: "customer" });
    expect(await lineRate(f.shopC, f.ryder, f.gesiSet)).toMatchObject({ rate: 110, source: "default" });

    await set(f.firstStudent, null);
    expect(await rows()).toEqual([[null, 110]]);
  });
});
