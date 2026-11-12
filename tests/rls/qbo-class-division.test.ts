/**
 * QuickBooks Division per customer (qbo_customer_division) and Class per shop
 * (qbo_affiliate_class) are CDS only, like the other QuickBooks mappings: a shop and an
 * anonymous caller read nothing and cannot write, CDS reads and edits them.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let customer: string;
let shopId: string;
let cds: Login;
let shop: Login;

beforeAll(async () => {
  shopId = (await must(admin.from("affiliates").insert({ short_code: `QCL-${runId}`, display_name: `Shop class ${runId}` }).select().single())).id;
  customer = (await must(admin.from("customers").insert({ code: `QCD-${runId}`, name: `Customer division ${runId}` }).select().single())).id;
  await must(admin.from("qbo_customer_division").insert({ customer_id: customer, qbo_department_id: "3", qbo_department_name: "RYDER INCOME" }));
  await must(admin.from("qbo_affiliate_class").insert({ affiliate_id: shopId, qbo_class_id: "12", qbo_class_name: "CDS Houston" }));
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  const rowIds = [customer, shopId, cds?.id, shop?.id].filter((v): v is string => !!v);
  await deleteLogins();
  // The mapping rows go with their customer and shop (on delete cascade).
  if (customer) await must(admin.from("customers").delete().eq("id", customer));
  if (shopId) await must(admin.from("affiliates").delete().eq("id", shopId));
  await must(admin.from("audit_log").delete().in("row_id", rowIds));
  for (const [table, column, id] of [
    ["qbo_customer_division", "customer_id", customer],
    ["qbo_affiliate_class", "affiliate_id", shopId],
  ] as const) {
    const left = await must(admin.from(table).select(column).eq(column, id));
    expect(left, table).toEqual([]);
  }
}, 120_000);

describe("QuickBooks Division and Class mappings", () => {
  it("a shop reads nothing and cannot write", async () => {
    for (const table of ["qbo_customer_division", "qbo_affiliate_class"]) {
      const { data, error } = await shop.client.from(table).select("*").limit(5);
      expect(error ? [] : data, table).toEqual([]);
    }
    const insert = await shop.client.from("qbo_affiliate_class").insert({ affiliate_id: shopId, qbo_class_id: "99", qbo_class_name: "x" });
    expect(insert.error).not.toBeNull();
    await shop.client.from("qbo_affiliate_class").update({ qbo_class_id: "99" }).eq("affiliate_id", shopId);
    await shop.client.from("qbo_customer_division").update({ qbo_department_id: "99" }).eq("customer_id", customer);
    await shop.client.from("qbo_customer_division").delete().eq("customer_id", customer);
    expect((await must(admin.from("qbo_affiliate_class").select("qbo_class_id").eq("affiliate_id", shopId).single())).qbo_class_id).toBe("12");
    expect((await must(admin.from("qbo_customer_division").select("qbo_department_id").eq("customer_id", customer).single())).qbo_department_id).toBe(
      "3",
    );
  });

  it("an anonymous caller reads nothing", async () => {
    for (const table of ["qbo_customer_division", "qbo_affiliate_class"]) {
      const { data, error } = await anon().from(table).select("*").limit(5);
      expect(error ? [] : data, table).toEqual([]);
    }
  });

  it("CDS reads and edits them", async () => {
    const division = await must(cds.client.from("qbo_customer_division").select("qbo_department_id, qbo_department_name").eq("customer_id", customer));
    expect(division).toEqual([{ qbo_department_id: "3", qbo_department_name: "RYDER INCOME" }]);
    const cls = await must(cds.client.from("qbo_affiliate_class").select("qbo_class_id, qbo_class_name").eq("affiliate_id", shopId));
    expect(cls).toEqual([{ qbo_class_id: "12", qbo_class_name: "CDS Houston" }]);
    await must(cds.client.from("qbo_affiliate_class").update({ qbo_class_name: "CDS Houston TX" }).eq("affiliate_id", shopId));
    const log = await must(admin.from("audit_log").select("action, actor_id").eq("table_name", "qbo_affiliate_class").eq("row_id", shopId));
    expect(log).toContainEqual({ action: "update", actor_id: cds.id });
  });

  it("refuse an empty QuickBooks id", async () => {
    const { error } = await admin.from("qbo_customer_division").update({ qbo_department_id: " " }).eq("customer_id", customer);
    expect(error).not.toBeNull();
  });
});
