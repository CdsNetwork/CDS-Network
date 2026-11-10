/**
 * CDS's in-house shop (20261110030000_in_house_shop.sql).
 *
 * CDS sells some parts itself: those orders go to the shop "CDS Inc (in-house)". On them the
 * shop amount is CDS's own cost (rows of the in-house shop only, never a default or customer
 * shop rate), completion fills the reference number in by itself, and the in-house login is
 * an ordinary shop login: no CDS rights, and other shops see nothing of it.
 *
 * The in-house shop itself comes from the migration and is never changed here. Other
 * fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Row = { id: string };

async function insertOne<T extends Row>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const f = {} as {
  inHouse: string;
  shopA: string;
  shopB: string;
  firstStudent: string;
  ryder: string;
  gesi: string;
  plain: string;
  costSet: string;
};
let cds: Login;
let inHouseLogin: Login;
let shopA: Login;

beforeAll(async () => {
  const shops = await must(admin.from("affiliates").select("id").eq("is_in_house", true));
  if (shops.length !== 1) throw new Error(`expected one in-house shop, found ${shops.length}`);
  f.inHouse = shops[0].id;
  f.shopA = (await insertOne("affiliates", { short_code: `IHA-${runId}`, display_name: `Shop IHA ${runId}` })).id;
  f.shopB = (await insertOne("affiliates", { short_code: `IHB-${runId}`, display_name: `Shop IHB ${runId}` })).id;
  f.firstStudent = (await insertOne("customers", { code: `IHFS-${runId}`, name: `First Student IH ${runId}` })).id;
  f.ryder = (await insertOne("customers", { code: `IHRY-${runId}`, name: `Ryder IH ${runId}` })).id;
  const item = (sku: string) =>
    insertOne("catalog_items", { sku: `${sku}-${runId}`, category: "part", name: "Test in-house part", tax_class: "parts" });
  f.gesi = (await item("CDS-DPF-GESI-IH")).id;
  f.plain = (await item("CDS-IH-PLAIN")).id;
  f.costSet = (await item("CDS-IH-COST")).id;

  const from = "2026-01-01";
  await must(
    admin.from("shop_rates").insert([
      { catalog_item_id: f.gesi, amount: 100, effective_from: from },
      { catalog_item_id: f.gesi, customer_id: f.firstStudent, amount: 150, effective_from: from },
      { catalog_item_id: f.gesi, affiliate_id: f.shopB, amount: 120, effective_from: from },
      // CDS's own cost: any customer, and a different one on First Student orders.
      { catalog_item_id: f.gesi, affiliate_id: f.inHouse, amount: 80, effective_from: from },
      { catalog_item_id: f.gesi, affiliate_id: f.inHouse, customer_id: f.firstStudent, amount: 85, effective_from: from },
      // Only a default and a customer rate: no CDS cost.
      { catalog_item_id: f.plain, amount: 40, effective_from: from },
      { catalog_item_id: f.plain, customer_id: f.firstStudent, amount: 45, effective_from: from },
    ]),
  );
  await must(
    admin.from("sell_prices").insert([
      { catalog_item_id: f.gesi, amount: 400, effective_from: from },
      { catalog_item_id: f.plain, amount: 90, effective_from: from },
      { catalog_item_id: f.costSet, amount: 90, effective_from: from },
    ]),
  );
  cds = await createLogin("cds", null);
  inHouseLogin = await createLogin("shop", f.inHouse);
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
      for (const table of ["shop_rates", "sell_prices"]) {
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
async function newWo(
  shop: string,
  customer: string,
  status = "accepted",
  requestType: "service" | "parts_only" = "service",
): Promise<{ id: string; wo_number: number }> {
  unit += 1;
  const wo = await must(
    admin
      .from("work_orders")
      .insert({
        customer_id: customer,
        location_label: `TEST-${runId}`,
        fulfillment: "shipping",
        affiliate_id: shop,
        status,
        request_type: requestType,
        unit_number: `IH-${unit}`,
        requested_work: "Test in-house sale",
      })
      .select("id, wo_number")
      .single(),
  );
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo as { id: string; wo_number: number };
}

async function addLine(wo: string, item: string, rate?: number) {
  const line = await must(
    admin
      .from("work_order_lines")
      .insert({ work_order_id: wo, catalog_item_id: item, qty: 1, ...(rate !== undefined ? { shop_unit_rate: rate } : {}) })
      .select("id, shop_unit_rate, shop_rate_source")
      .single(),
  );
  return {
    id: line.id as string,
    rate: line.shop_unit_rate === null ? null : Number(line.shop_unit_rate),
    source: line.shop_rate_source as string,
  };
}

async function lineOn(shop: string, customer: string, item: string) {
  const wo = await newWo(shop, customer);
  return { wo: wo.id, ...(await addLine(wo.id, item)) };
}

const readLine = async (id: string) => {
  const r = await must(admin.from("work_order_lines").select("shop_unit_rate, shop_rate_source").eq("id", id).single());
  return { rate: r.shop_unit_rate === null ? null : Number(r.shop_unit_rate), source: r.shop_rate_source as string };
};

describe("the in-house shop", () => {
  it("exists exactly once, named CDS Inc (in-house), active", async () => {
    const rows = await must(admin.from("affiliates").select("id, display_name, active, kind").eq("is_in_house", true));
    expect(rows).toEqual([{ id: f.inHouse, display_name: "CDS Inc (in-house)", active: true, kind: "cds_owned" }]);
  });

  it("a second in-house shop is refused", async () => {
    const { error } = await admin
      .from("affiliates")
      .insert({ short_code: `IHX-${runId}`, display_name: `Second in-house ${runId}`, is_in_house: true });
    expect(error).not.toBeNull();
  });

  it("CDS cannot deactivate it, nor turn another shop into the in-house shop", async () => {
    const off = await cds.client.from("affiliates").update({ active: false }).eq("id", f.inHouse);
    expect(off.error?.message).toMatch(/cannot be deactivated/);
    const flag = await cds.client.from("affiliates").update({ is_in_house: true }).eq("id", f.shopA);
    expect(flag.error).not.toBeNull();
    const after = await must(admin.from("affiliates").select("active").eq("id", f.inHouse).single());
    expect(after.active).toBe(true);
  });

  it("shows in the dispatch shop list and takes a dispatch", async () => {
    const shops = await must(cds.client.from("affiliates").select("id").eq("active", true));
    expect(shops.map((s: Row) => s.id)).toContain(f.inHouse);
    const wo = await newWo(null as unknown as string, f.ryder, "pending_review");
    await addLine(wo.id, f.gesi);
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: wo.id, p_affiliate: f.inHouse }));
    const after = await must(admin.from("work_orders").select("affiliate_id, status").eq("id", wo.id).single());
    expect(after).toEqual({ affiliate_id: f.inHouse, status: "awaiting_acceptance" });
  });
});

describe("rate on in-house lines: CDS's own cost only", () => {
  it("uses the in-house row, never the default, a customer rate or another shop's rate", async () => {
    expect(await lineOn(f.inHouse, f.ryder, f.gesi)).toMatchObject({ rate: 80, source: "shop" });
  });

  it("uses the in-house row for this customer first", async () => {
    expect(await lineOn(f.inHouse, f.firstStudent, f.gesi)).toMatchObject({ rate: 85, source: "shop" });
  });

  it("no in-house row: no rate (TBD), even with a default and a customer rate", async () => {
    expect(await lineOn(f.inHouse, f.firstStudent, f.plain)).toMatchObject({ rate: null });
    expect(await lineOn(f.inHouse, f.ryder, f.plain)).toMatchObject({ rate: null });
  });

  it("CDS can type the cost on a line (manual)", async () => {
    const wo = await newWo(f.inHouse, f.ryder);
    const { data, error } = await cds.client
      .from("work_order_lines")
      .insert({ work_order_id: wo.id, catalog_item_id: f.plain, qty: 1, shop_unit_rate: 33 })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    expect(await readLine(data.id)).toEqual({ rate: 33, source: "manual" });
  });

  it("outside shops are unchanged and never take the in-house row", async () => {
    expect(await lineOn(f.shopA, f.ryder, f.gesi)).toMatchObject({ rate: 100, source: "default" });
    expect(await lineOn(f.shopA, f.firstStudent, f.gesi)).toMatchObject({ rate: 150, source: "customer" });
    expect(await lineOn(f.shopB, f.ryder, f.gesi)).toMatchObject({ rate: 120, source: "shop" });
  });

  it("moving an order to the in-house shop and back re-picks every line CDS did not type", async () => {
    const wo = await newWo(f.shopA, f.ryder);
    const gesi = await addLine(wo.id, f.gesi);
    const plain = await addLine(wo.id, f.plain);
    expect(gesi).toMatchObject({ rate: 100, source: "default" });
    expect(plain).toMatchObject({ rate: 40, source: "default" });
    const { data: typed, error } = await cds.client
      .from("work_order_lines")
      .insert({ work_order_id: wo.id, catalog_item_id: f.plain, qty: 1, shop_unit_rate: 12 })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await must(cds.client.from("work_orders").update({ affiliate_id: f.inHouse }).eq("id", wo.id));
    expect(await readLine(gesi.id)).toEqual({ rate: 80, source: "shop" });
    expect(await readLine(plain.id)).toEqual({ rate: null, source: "default" });
    expect(await readLine(typed.id)).toEqual({ rate: 12, source: "manual" });

    await must(cds.client.from("work_orders").update({ affiliate_id: f.shopB }).eq("id", wo.id));
    expect(await readLine(gesi.id)).toEqual({ rate: 120, source: "shop" });
    expect(await readLine(plain.id)).toEqual({ rate: 40, source: "default" });
    expect(await readLine(typed.id)).toEqual({ rate: 12, source: "manual" });
  });
});

describe("cds_set_in_house_cost", () => {
  it("sets, changes and clears CDS's cost without touching the shop rates", async () => {
    const set = (amount: number | null) =>
      must(cds.client.rpc("cds_set_in_house_cost", { p_catalog_item: f.costSet, p_amount: amount }));
    const rows = async () =>
      (await must(admin.from("shop_rates").select("affiliate_id, customer_id, amount").eq("catalog_item_id", f.costSet)))
        .map((r: { affiliate_id: string | null; customer_id: string | null; amount: number }) => [
          r.affiliate_id,
          r.customer_id,
          Number(r.amount),
        ]);

    await must(cds.client.rpc("cds_set_price", { p_kind: "shop_rate", p_catalog_item: f.costSet, p_customer: null, p_amount: 50 }));
    await set(30);
    expect(await rows()).toEqual(expect.arrayContaining([[null, null, 50], [f.inHouse, null, 30]]));
    await set(31);
    expect((await rows()).length).toBe(2);
    expect(await lineOn(f.inHouse, f.ryder, f.costSet)).toMatchObject({ rate: 31, source: "shop" });
    expect(await lineOn(f.shopA, f.ryder, f.costSet)).toMatchObject({ rate: 50, source: "default" });
    await set(null);
    expect(await rows()).toEqual([[null, null, 50]]);
  });

  it("is CDS only", async () => {
    for (const login of [inHouseLogin, shopA]) {
      const { error } = await login.client.rpc("cds_set_in_house_cost", { p_catalog_item: f.costSet, p_amount: 1 });
      expect(error).not.toBeNull();
    }
  });
});

describe("completing an in-house order", () => {
  async function readyWo(shop: string) {
    const wo = await newWo(shop, f.ryder);
    await addLine(wo.id, f.gesi);
    await must(
      admin.from("work_order_components").insert({
        work_order_id: wo.id,
        seq: 1,
        component_type: "EGR",
        manufacturer: "Test",
        part_number: `PN-${runId}`,
        serial_number: `SN-${runId}-${wo.wo_number}`,
        result: "passed",
      }),
    );
    return wo;
  }

  it("fills the reference number in when it is left empty", async () => {
    const wo = await readyWo(f.inHouse);
    await must(inHouseLogin.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "" }));
    const after = await must(admin.from("work_orders").select("status, affiliate_invoice_ref").eq("id", wo.id).single());
    expect(after).toEqual({ status: "completed", affiliate_invoice_ref: `IN-HOUSE-${wo.wo_number}` });
  });

  it("keeps a number the in-house login typed", async () => {
    const wo = await readyWo(f.inHouse);
    await must(inHouseLogin.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: " GESI-PO-7 " }));
    const after = await must(admin.from("work_orders").select("affiliate_invoice_ref").eq("id", wo.id).single());
    expect(after.affiliate_invoice_ref).toBe("GESI-PO-7");
  });

  it("an outside shop still must enter its invoice number", async () => {
    const wo = await readyWo(f.shopA);
    const { error } = await shopA.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "" });
    expect(error?.message).toMatch(/Enter your invoice or reference number/);
    await must(shopA.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "INV-1" }));
  });
});

describe("an in-house parts sale (request type parts_only) completes without components", () => {
  async function bareWo(shop: string, requestType: "service" | "parts_only") {
    const wo = await newWo(shop, f.ryder, "accepted", requestType);
    await addLine(wo.id, f.gesi);
    return wo;
  }

  it("in-house parts_only: completes with no component and gets the IN-HOUSE reference", async () => {
    const wo = await bareWo(f.inHouse, "parts_only");
    await must(inHouseLogin.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "" }));
    const after = await must(admin.from("work_orders").select("status, affiliate_invoice_ref").eq("id", wo.id).single());
    expect(after).toEqual({ status: "completed", affiliate_invoice_ref: `IN-HOUSE-${wo.wo_number}` });
  });

  it("in-house service order: still needs a component", async () => {
    const wo = await bareWo(f.inHouse, "service");
    const { error } = await inHouseLogin.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "" });
    expect(error?.message).toMatch(/Add at least one component/);
  });

  it("outside shop parts_only: still needs a component", async () => {
    const wo = await bareWo(f.shopA, "parts_only");
    const { error } = await shopA.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "INV-2" });
    expect(error?.message).toMatch(/Add at least one component/);
  });

  it("an extra work request still waiting blocks an in-house parts sale", async () => {
    const wo = await bareWo(f.inHouse, "parts_only");
    await must(
      admin.from("authorization_requests").insert({
        work_order_id: wo.id,
        seq: 1,
        kind: "part",
        catalog_item_id: f.plain,
        note: "Extra part",
      }),
    );
    const { error } = await inHouseLogin.client.rpc("shop_complete_work_order", { p_work_order: wo.id, p_invoice_ref: "" });
    expect(error?.message).toMatch(/extra work request is still waiting/);
  });
});

describe("visibility", () => {
  it("another shop sees no in-house order, rate or shop row", async () => {
    const wo = await newWo(f.inHouse, f.ryder);
    expect(await must(shopA.client.from("work_orders").select("id").eq("id", wo.id))).toEqual([]);
    expect(await must(shopA.client.from("shop_rates").select("id").eq("affiliate_id", f.inHouse))).toEqual([]);
    expect(await must(shopA.client.from("affiliates").select("id").eq("id", f.inHouse))).toEqual([]);
  });

  it("the in-house login is an ordinary shop login: its own orders and rates only, no CDS rights", async () => {
    const own = await newWo(f.inHouse, f.ryder);
    const other = await newWo(f.shopA, f.ryder);
    const seen = (await must(inHouseLogin.client.from("work_orders").select("id").in("id", [own.id, other.id]))).map(
      (r: Row) => r.id,
    );
    expect(seen).toEqual([own.id]);
    const rates = (await must(inHouseLogin.client.from("shop_rates").select("affiliate_id").eq("catalog_item_id", f.gesi))).map(
      (r: { affiliate_id: string | null }) => r.affiliate_id,
    );
    expect(rates).not.toContain(f.shopB);
    expect(await must(inHouseLogin.client.from("sell_prices").select("id").eq("catalog_item_id", f.gesi))).toEqual([]);
    expect(await must(inHouseLogin.client.from("affiliates").select("id").neq("id", f.inHouse))).toEqual([]);
    const price = await inHouseLogin.client.rpc("cds_set_price", {
      p_kind: "fleet",
      p_catalog_item: f.gesi,
      p_customer: null,
      p_amount: 1,
    });
    expect(price.error).not.toBeNull();
    const dispatch = await inHouseLogin.client.rpc("cds_dispatch_work_order", { p_work_order: other.id, p_affiliate: f.inHouse });
    expect(dispatch.error).not.toBeNull();
    const flip = await inHouseLogin.client.from("affiliates").update({ display_name: "x" }).eq("id", f.inHouse).select("id");
    expect(flip.data ?? []).toEqual([]);
  });
});
