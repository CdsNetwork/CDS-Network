/**
 * Business dates are Pacific (CDS works from California), and the change log only records
 * changes someone can see.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards,
 * so the suite can run against a local stack or a staging project.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shop: string; customer: string; item: string };

let f: Fixture;
let cds: Login;

/** Today's date in California, computed independently of the app code. */
function pacificToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function auditCount(rowId: string): Promise<number> {
  const { count, error } = await admin.from("audit_log").select("id", { count: "exact", head: true }).eq("row_id", rowId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

beforeAll(async () => {
  const shop = await insertOne("affiliates", { short_code: `PD-${runId}`, display_name: `Shop PD ${runId}` });
  const customer = await insertOne("customers", { code: `PDC-${runId}`, name: `Customer PD ${runId}` });
  const item = await insertOne("catalog_items", {
    sku: `PD-${runId}`,
    category: "service",
    name: "Test date cleaning",
    tax_class: "labor",
  });
  f = { shop: shop.id, customer: customer.id, item: item.id };
  cds = await createLogin("cds", null);
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
    const items = await must(admin.from("catalog_items").select("id").like("sku", suffix));
    const itemIds = items.map((r: { id: string }) => r.id);
    rowIds.push(...itemIds);
    rowIds.push(...(await must(admin.from("customers").select("id").like("code", suffix))).map((r: { id: string }) => r.id));
    rowIds.push(...(await must(admin.from("affiliates").select("id").like("short_code", suffix))).map((r: { id: string }) => r.id));
    if (itemIds.length) {
      for (const table of ["shop_rates", "sell_prices", "customer_price_overrides"]) {
        const rows = await must(admin.from(table).select("id").in("catalog_item_id", itemIds));
        rowIds.push(...rows.map((r: { id: string }) => r.id));
      }
    }
  });
  await step("delete logins", () => deleteLogins());
  await step("delete catalog items", () => must(admin.from("catalog_items").delete().like("sku", suffix)));
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  // The fixture's change log rows would otherwise show on the Change log tab.
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));

  const head = { count: "exact" as const, head: true };
  const left: string[] = [];
  for (const [label, query] of [
    ["catalog items", admin.from("catalog_items").select("id", head).like("sku", suffix)],
    ["customers", admin.from("customers").select("id", head).like("code", suffix)],
    ["shops", admin.from("affiliates").select("id", head).like("short_code", suffix)],
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
});

describe("BUG-17: price start dates are Pacific dates", () => {
  // The Pacific and UTC dates differ only between 17:00 and 24:00 Pacific time (16:00 to
  // 24:00 in winter), so before the fix this test fails only when run in that window. At
  // other times it passes either way and guards against a regression in the evening.
  it("a price set by a CDS login starts on today's date in America/Los_Angeles", async () => {
    for (const [kind, customer, amount] of [
      ["shop_rate", null, 17.92],
      ["fleet", null, 24.5],
      ["override", f.customer, 11.11],
    ] as const) {
      await must(
        cds.client.rpc("cds_set_price", { p_kind: kind, p_catalog_item: f.item, p_customer: customer, p_amount: amount }),
      );
    }
    const expected = pacificToday();
    const rate = await must(admin.from("shop_rates").select("effective_from, amount").eq("catalog_item_id", f.item).single());
    const fleet = await must(admin.from("sell_prices").select("effective_from, amount").eq("catalog_item_id", f.item).single());
    const override = await must(
      admin.from("customer_price_overrides").select("effective_from, amount").eq("catalog_item_id", f.item).single(),
    );
    expect(rate).toEqual({ effective_from: expected, amount: 17.92 });
    expect(fleet).toEqual({ effective_from: expected, amount: 24.5 });
    expect(override).toEqual({ effective_from: expected, amount: 11.11 });
  });

  it("a price row added without a start date starts on the Pacific date (column default)", async () => {
    const shop = await must(
      admin.from("shop_rates").insert({ catalog_item_id: f.item, affiliate_id: f.shop, amount: 15 }).select("effective_from").single(),
    );
    expect(shop.effective_from).toBe(pacificToday());
  });
});

describe("Change log: only visible changes are recorded", () => {
  it("saving a catalog item without changes writes no change log row", async () => {
    const item = await must(
      cds.client.from("catalog_items").select("sku, category, name, oe_cross, tax_class, shop_selectable, active").eq("id", f.item).single(),
    );
    const before = await auditCount(f.item);
    await must(cds.client.from("catalog_items").update(item).eq("id", f.item));
    expect(await auditCount(f.item)).toBe(before);

    await must(cds.client.from("catalog_items").update({ name: "Test date cleaning 2" }).eq("id", f.item));
    expect(await auditCount(f.item)).toBe(before + 1);
  });

  it("an update that only moves updated_at writes no change log row", async () => {
    const before = await auditCount(f.shop);
    // affiliates has a trigger that sets updated_at on every update.
    await must(cds.client.from("affiliates").update({ display_name: `Shop PD ${runId}` }).eq("id", f.shop));
    expect(await auditCount(f.shop)).toBe(before);

    await must(cds.client.from("affiliates").update({ city: "Fresno" }).eq("id", f.shop));
    expect(await auditCount(f.shop)).toBe(before + 1);
  });
});
