/**
 * BUG-M2-9: a tax exempt customer (customer_billing.tax_exempt) is never charged sales tax.
 * The order's tax settings follow the exemption: a new order of an exempt customer starts
 * with no tax (both the Create Work Order form and email intake), open orders lose their tax
 * when the customer becomes exempt, and get the state's starting tax back when the
 * exemption ends. Invoiced orders never change.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

type Fixture = { shop: string; exempt: string; taxable: string; exemptLoc: string; taxableLoc: string; item: string };
type TaxRow = {
  tax_rate: number;
  tax_parts: boolean;
  tax_labor: boolean;
  tax_shipping: boolean;
  tax_jurisdiction: string | null;
  tax_source: string | null;
};

let f: Fixture;
let cds: Login;
let ohio: { rate: number; taxes_parts: boolean; taxes_labor: boolean; taxes_shipping: boolean };

const NO_TAX = { tax_rate: 0, tax_parts: false, tax_labor: false, tax_shipping: false, tax_source: "customer_exempt" };
const MSG = (n: number) => `<tax-${runId}-${n}@test.invalid>`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function tax(wo: string): Promise<TaxRow> {
  const row = await must(
    admin
      .from("work_order_internal")
      .select("tax_rate, tax_parts, tax_labor, tax_shipping, tax_jurisdiction, tax_source")
      .eq("work_order_id", wo)
      .single(),
  );
  return { ...(row as TaxRow), tax_rate: Number((row as TaxRow).tax_rate) };
}

/** What the Create Work Order form does: create the order, then set the state's starting tax. */
async function createLikeForm(customer: string, location: string): Promise<string> {
  const wo = (await must(
    cds.client.rpc("cds_create_work_order", {
      p_customer: customer,
      p_location: location,
      p_location_label: null,
      p_site_address: null,
      p_request_type: "service",
      p_fulfillment: "pickup",
      p_unit_number: "TX-1",
      p_po_number: null,
      p_requested_work: "DPF clean",
      p_internal_notes: null,
      p_lines: [{ catalog_item_id: f.item, qty: 1 }],
    }),
  )) as string;
  await must(
    cds.client
      .from("work_order_internal")
      .update({
        tax_rate: ohio.rate,
        tax_parts: ohio.taxes_parts,
        tax_labor: ohio.taxes_labor,
        tax_shipping: ohio.taxes_shipping,
        tax_jurisdiction: "OH",
        tax_source: "state_fallback",
      })
      .eq("work_order_id", wo),
  );
  return wo;
}

beforeAll(async () => {
  ohio = await must(
    admin.from("tax_rates").select("rate, taxes_parts, taxes_labor, taxes_shipping").eq("market", "US").eq("region", "OH").is("postal_code", null).single(),
  );
  ohio = { ...ohio, rate: Number(ohio.rate) };
  const shopRow = await insertOne("affiliates", { short_code: `TX-${runId}`, display_name: `Shop TX ${runId}` });
  const exempt = await insertOne("customers", { code: `TXE-${runId}`, name: `Exempt ${runId}` });
  const taxable = await insertOne("customers", { code: `TXT-${runId}`, name: `Taxable ${runId}` });
  await must(admin.from("customer_billing").insert({ customer_id: exempt.id, tax_exempt: true }));
  const loc = (customer: string, n: string) =>
    insertOne("customer_locations", {
      customer_id: customer,
      code: `${n}${runId.slice(0, 3)}-TAX`,
      location_number: `${n}${runId.slice(0, 3)}`,
      name: `Tax ${runId}`,
      address_raw: "1 Test Way, Akron, OH 44301",
      region: "OH",
    });
  const exemptLoc = await loc(exempt.id, "7");
  const taxableLoc = await loc(taxable.id, "8");
  const item = await insertOne("catalog_items", { sku: `TX-${runId}`, category: "service", name: `Tax test ${runId}`, tax_class: "labor" });
  await must(admin.from("sell_prices").insert({ catalog_item_id: item.id, market: "US", amount: 100, effective_from: "2026-01-01" }));
  f = { shop: shopRow.id, exempt: exempt.id, taxable: taxable.id, exemptLoc: exemptLoc.id, taxableLoc: taxableLoc.id, item: item.id };
  cds = await createLogin("cds", null);
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
  if (f) {
    const customers = [f.exempt, f.taxable];
    const woIds: string[] = [];
    await step("find work orders", async () => {
      woIds.push(...(await must(admin.from("work_orders").select("id").in("customer_id", customers))).map((r: { id: string }) => r.id));
    });
    await step("delete emails", () => must(admin.from("inbound_emails").delete().like("provider_message_id", `<tax-${runId}-%`)));
    if (woIds.length) {
      await step("delete sync rows", () => must(admin.from("integration_sync").delete().in("entity_id", woIds)));
      await step("delete work orders", () => must(admin.from("work_orders").delete().in("id", woIds)));
    }
    await step("delete locations", () => must(admin.from("customer_locations").delete().in("customer_id", customers)));
    await step("delete prices", () => must(admin.from("sell_prices").delete().eq("catalog_item_id", f.item)));
    await step("delete catalog", () => must(admin.from("catalog_items").delete().eq("id", f.item)));
    await step("delete customers", () => must(admin.from("customers").delete().in("id", customers)));
    await step("delete shop", () => must(admin.from("affiliates").delete().eq("id", f.shop)));
    const rowIds = [f.shop, ...customers, f.exemptLoc, f.taxableLoc, f.item, cds?.id].filter((v): v is string => !!v);
    await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  }
  await step("delete logins", () => deleteLogins());
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("BUG-M2-9: tax settings follow the customer's tax exemption", () => {
  it("a new order of an exempt customer starts with no tax (Create Work Order form)", async () => {
    const wo = await createLikeForm(f.exempt, f.exemptLoc);
    expect(await tax(wo)).toMatchObject(NO_TAX);
  });

  it("a new order of a taxable customer keeps the state's starting tax", async () => {
    const wo = await createLikeForm(f.taxable, f.taxableLoc);
    expect(await tax(wo)).toMatchObject({
      tax_rate: ohio.rate,
      tax_parts: ohio.taxes_parts,
      tax_labor: ohio.taxes_labor,
      tax_shipping: ohio.taxes_shipping,
      tax_source: "state_fallback",
    });
  });

  it("an email intake draft of an exempt customer starts with no tax", async () => {
    const email = await insertOne<{ id: string }>("inbound_emails", {
      provider_message_id: MSG(1),
      received_at: new Date().toISOString(),
      from_address: `desk@tax-${runId.toLowerCase()}.example`,
      subject: `Tax test ${runId}`,
      body_text: "DPF clean",
      source: "webhook",
    });
    const wo = (await must(
      cds.client.rpc("intake_create_draft_work_order", {
        p_email: email.id,
        p_customer: f.exempt,
        p_location: f.exemptLoc,
        p_location_label: null,
        p_site_address: null,
        p_request_type: "service",
        p_fulfillment: "pickup",
        p_unit_number: "TX-2",
        p_po_number: null,
        p_requested_work: "DPF clean",
        p_internal_notes: null,
        p_review_reason: null,
        p_lines: [{ catalog_item_id: f.item, qty: 1 }],
      }),
    )) as string;
    expect(await tax(wo)).toMatchObject(NO_TAX);
  });

  it("CDS cannot put tax back on an exempt customer's order", async () => {
    const wo = await createLikeForm(f.exempt, f.exemptLoc);
    await must(
      cds.client
        .from("work_order_internal")
        .update({ tax_rate: 7, tax_parts: true, tax_labor: true, tax_shipping: true, tax_source: "manual" })
        .eq("work_order_id", wo),
    );
    expect(await tax(wo)).toMatchObject(NO_TAX);
  });

  it("open orders follow a change of exemption; invoiced orders never change", async () => {
    const open = await createLikeForm(f.taxable, f.taxableLoc);
    const invoiced = await createLikeForm(f.taxable, f.taxableLoc);
    await must(admin.from("work_orders").update({ status: "invoiced", fulfillment: "shipping", affiliate_id: f.shop, affiliate_invoice_ref: "INV-1" }).eq("id", invoiced));
    const invoicedBefore = await tax(invoiced);

    await must(admin.from("customer_billing").insert({ customer_id: f.taxable, tax_exempt: true }));
    expect(await tax(open)).toMatchObject(NO_TAX);
    expect(await tax(invoiced)).toEqual(invoicedBefore);

    await must(admin.from("customer_billing").update({ tax_exempt: false }).eq("customer_id", f.taxable));
    expect(await tax(open)).toMatchObject({
      tax_rate: ohio.rate,
      tax_parts: ohio.taxes_parts,
      tax_labor: ohio.taxes_labor,
      tax_shipping: ohio.taxes_shipping,
      tax_jurisdiction: "OH",
      tax_source: "state_fallback",
    });
    expect(await tax(invoiced)).toEqual(invoicedBefore);
  });

  it("changing an order's customer re-evaluates its tax", async () => {
    const wo = await createLikeForm(f.taxable, f.taxableLoc);
    await must(admin.from("work_orders").update({ customer_id: f.exempt, location_id: f.exemptLoc }).eq("id", wo));
    expect(await tax(wo)).toMatchObject(NO_TAX);

    // Back to a customer without an exemption: the state's starting tax, as a new order.
    await must(cds.client.from("work_orders").update({ customer_id: f.taxable, location_id: f.taxableLoc }).eq("id", wo));
    expect(await tax(wo)).toMatchObject({
      tax_rate: ohio.rate,
      tax_parts: ohio.taxes_parts,
      tax_labor: ohio.taxes_labor,
      tax_shipping: ohio.taxes_shipping,
      tax_jurisdiction: "OH",
      tax_source: "state_fallback",
    });
  });

  it("an invoiced order's customer change leaves its tax alone", async () => {
    const wo = await createLikeForm(f.taxable, f.taxableLoc);
    await must(admin.from("work_orders").update({ status: "invoiced", fulfillment: "shipping", affiliate_id: f.shop, affiliate_invoice_ref: "INV-1" }).eq("id", wo));
    const before = await tax(wo);
    await must(admin.from("work_orders").update({ customer_id: f.exempt, location_id: f.exemptLoc }).eq("id", wo));
    expect(await tax(wo)).toEqual(before);
  });

  it("BUG-M2-13: a cancelled order keeps its stored tax when the exemption or the customer changes", async () => {
    const cancelled = await createLikeForm(f.taxable, f.taxableLoc);
    const moved = await createLikeForm(f.taxable, f.taxableLoc);
    await must(admin.from("work_orders").update({ status: "cancelled" }).in("id", [cancelled, moved]));
    const before = await tax(cancelled);
    expect(before).toMatchObject({ tax_rate: ohio.rate, tax_source: "state_fallback" });

    // The customer becomes exempt, then not: the cancelled order never changes.
    await must(admin.from("customer_billing").upsert({ customer_id: f.taxable, tax_exempt: true }));
    expect(await tax(cancelled)).toEqual(before);
    // Editing another field of the cancelled order does not apply the exemption either.
    await must(admin.from("work_order_internal").update({ internal_notes: `cancelled ${runId}` }).eq("work_order_id", cancelled));
    expect(await tax(cancelled)).toEqual(before);
    await must(admin.from("customer_billing").update({ tax_exempt: false }).eq("customer_id", f.taxable));
    expect(await tax(cancelled)).toEqual(before);

    // Moved to an exempt customer while cancelled: unchanged.
    await must(admin.from("work_orders").update({ customer_id: f.exempt, location_id: f.exemptLoc }).eq("id", moved));
    expect(await tax(moved)).toEqual(before);
  });

  it("CDS cannot change the tax of an invoiced order through the API", async () => {
    const wo = await createLikeForm(f.taxable, f.taxableLoc);
    await must(admin.from("work_orders").update({ status: "invoiced", fulfillment: "shipping", affiliate_id: f.shop, affiliate_invoice_ref: "INV-1" }).eq("id", wo));
    const before = await tax(wo);
    for (const change of [
      { tax_rate: 9 },
      { tax_parts: !before.tax_parts },
      { tax_labor: !before.tax_labor },
      { tax_shipping: !before.tax_shipping },
      { tax_source: "manual" },
      { tax_jurisdiction: "CA" },
    ]) {
      const { error } = await cds.client.from("work_order_internal").update(change).eq("work_order_id", wo);
      expect(error?.message, JSON.stringify(change)).toMatch(/invoiced/);
    }
    expect(await tax(wo)).toEqual(before);
    // Other fields of an invoiced order can still be edited, and writing the same tax is fine.
    await must(cds.client.from("work_order_internal").update({ internal_notes: `note ${runId}`, tax_rate: before.tax_rate }).eq("work_order_id", wo));
  });
});
