/**
 * The customer's stated manufacturer on the order (Sarah, CDS, 2026-11-23):
 * work_orders.customer_manufacturer. CDS sets it on Create Work Order and email intake sets it
 * on the draft; CDS can change it at any time; the shop the order is dispatched to reads it like
 * the unit, PO and Part #, and cannot change it.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `CMF-${runId}`;
const MSG = `<cmf-${runId}@test.invalid>`;
let shop: string;
let otherShop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;
let otherLogin: Login;

beforeAll(async () => {
  shop = ((await must(admin.from("affiliates").insert({ short_code: LABEL, display_name: `Manufacturer Shop ${runId}` }).select().single())) as { id: string }).id;
  otherShop = ((await must(admin.from("affiliates").insert({ short_code: `${LABEL}-B`, display_name: `Other Shop ${runId}` }).select().single())) as { id: string }).id;
  customer = ((await must(admin.from("customers").insert({ code: LABEL, name: `Manufacturer Customer ${runId}` }).select().single())) as { id: string }).id;
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);
  otherLogin = await createLogin("shop", otherShop);
}, 120_000);

afterAll(async () => {
  const ids = ((await must(admin.from("work_orders").select("id").eq("customer_id", customer))) as { id: string }[]).map((r) => r.id);
  await must(admin.from("inbound_emails").delete().eq("provider_message_id", MSG));
  if (ids.length) {
    await must(admin.from("integration_sync").delete().in("entity_id", ids));
    await must(admin.from("work_orders").delete().in("id", ids));
  }
  await deleteLogins();
  await must(admin.from("customers").delete().eq("code", LABEL));
  await must(admin.from("affiliates").delete().in("short_code", [LABEL, `${LABEL}-B`]));
}, 120_000);

const create = (manufacturer: string | null) =>
  cds.client.rpc("cds_create_work_order", {
    p_customer: customer,
    p_location: null,
    p_location_label: LABEL,
    p_site_address: null,
    p_request_type: "service",
    p_fulfillment: "shipping",
    p_unit_number: "CMF-1",
    p_po_number: "PO-CPN",
    p_requested_work: "DPF cleaning",
    p_internal_notes: null,
    p_lines: [],
    p_customer_part_number: "A0009999",
    p_customer_manufacturer: manufacturer,
  });

const mfrOf = async (id: string) =>
  ((await must(admin.from("work_orders").select("customer_manufacturer").eq("id", id).single())) as { customer_manufacturer: string | null }).customer_manufacturer;

describe("customer_manufacturer", () => {
  it("is set by Create Work Order, trimmed, and empty stays empty", async () => {
    const wo = (await must(create("  Cummins "))) as string;
    expect(await mfrOf(wo)).toBe("Cummins");
    const none = (await must(create("  "))) as string;
    expect(await mfrOf(none)).toBeNull();
    expect((await create("x".repeat(101))).error).toBeTruthy();
  });

  it("Create Work Order still works without it (callers that do not send it)", async () => {
    const rest = {
      p_customer: customer,
      p_location: null,
      p_location_label: LABEL,
      p_site_address: null,
      p_request_type: "service",
      p_fulfillment: "shipping",
      p_unit_number: "CMF-0",
      p_po_number: "PO-CMF",
      p_requested_work: "DPF cleaning",
      p_internal_notes: null,
      p_lines: [],
    };
    const wo = (await must(cds.client.rpc("cds_create_work_order", rest))) as string;
    expect(await mfrOf(wo)).toBeNull();
  });

  it("is set by email intake on the draft", async () => {
    const email = (await must(
      admin
        .from("inbound_emails")
        .insert({ provider_message_id: MSG, received_at: new Date().toISOString(), from_address: "desk@cmf.example", subject: `CMF ${runId}`, source: "webhook" })
        .select("id")
        .single(),
    )) as { id: string };
    const wo = (await must(
      admin.rpc("intake_create_draft_work_order", {
        p_email: email.id,
        p_customer: customer,
        p_location: null,
        p_location_label: LABEL,
        p_site_address: null,
        p_request_type: "service",
        p_fulfillment: "pickup",
        p_unit_number: "CMF-2",
        p_po_number: null,
        p_requested_work: "DPF clean",
        p_internal_notes: "Created from an email to dispatch.\nManufacturer: Detroit.",
        p_review_reason: "From email: check before dispatch",
        p_lines: [],
        p_customer_part_number: null,
        p_customer_manufacturer: "Detroit",
      }),
    )) as string;
    expect(await mfrOf(wo)).toBe("Detroit");
  });

  it("is read by the shop the order is dispatched to, not by another shop, and only CDS changes it", async () => {
    const wo = (await must(create("Cummins"))) as string;
    await must(admin.from("work_orders").update({ affiliate_id: shop, status: "accepted" }).eq("id", wo));

    const seen = await must(shopLogin.client.from("work_orders").select("unit_number, customer_part_number, customer_manufacturer").eq("id", wo).single());
    expect(seen).toEqual({ unit_number: "CMF-1", customer_part_number: "A0009999", customer_manufacturer: "Cummins" });
    const other = await otherLogin.client.from("work_orders").select("customer_manufacturer").eq("id", wo);
    expect(other.data ?? []).toEqual([]);

    await shopLogin.client.from("work_orders").update({ customer_manufacturer: "SHOP" }).eq("id", wo);
    expect(await mfrOf(wo)).toBe("Cummins");

    // After acceptance, like the PO and Part # (updateWorkOrderManufacturer).
    await must(cds.client.from("work_orders").update({ customer_manufacturer: "Volvo" }).eq("id", wo).select("id").single());
    expect(await mfrOf(wo)).toBe("Volvo");
    expect((await cds.client.from("work_orders").update({ customer_manufacturer: "x".repeat(101) }).eq("id", wo)).error).toBeTruthy();
  });
});
