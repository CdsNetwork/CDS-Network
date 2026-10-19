/**
 * Email intake: inbound emails and sender domains are CDS-only (shops and anonymous callers
 * see and write nothing); intake_create_draft_work_order works for CDS staff and the
 * service role only, creates the order in Pending Review from source email_import, never
 * twice for one email, and leaves off lines without a customer price.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { supabaseIntakeStore } from "@/lib/intake/supabase-store";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

vi.mock("server-only", () => ({}));

type Fixture = { shop: string; customer: string; location: string; priced: string; unpriced: string; domain: string };

let f: Fixture;
let cds: Login;
let shop: Login;

const MSG = (n: number) => `<intake-${runId}-${n}@test.invalid>`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function insertEmail(n: number, over: Record<string, unknown> = {}): Promise<string> {
  const row = await insertOne<{ id: string }>("inbound_emails", {
    provider_message_id: MSG(n),
    received_at: new Date().toISOString(),
    from_header: `Fleet Desk <desk@in-${runId.toLowerCase()}.example>`,
    from_address: `desk@in-${runId.toLowerCase()}.example`,
    subject: `Intake test ${runId} ${n}`,
    body_text: "DPF clean for unit 100, PO 200",
    source: "webhook",
    ...over,
  });
  return row.id;
}

function draftArgs(email: string, over: Record<string, unknown> = {}) {
  return {
    p_email: email,
    p_customer: f.customer,
    p_location: f.location,
    p_location_label: null,
    p_site_address: null,
    p_request_type: "service",
    p_fulfillment: "pickup",
    p_unit_number: "100",
    p_po_number: "200",
    p_requested_work: "DPF clean",
    p_internal_notes: "Created from an email to dispatch.",
    p_review_reason: "From email (high confidence): check before dispatch",
    p_lines: [
      { catalog_item_id: f.priced, qty: 1 },
      { catalog_item_id: f.unpriced, qty: 2 },
    ],
    ...over,
  };
}

beforeAll(async () => {
  const shopRow = await insertOne("affiliates", { short_code: `IN-${runId}`, display_name: `Shop IN ${runId}` });
  const customer = await insertOne("customers", { code: `IN-${runId}`, name: `Customer IN ${runId}` });
  const location = await insertOne("customer_locations", {
    customer_id: customer.id,
    code: `9${runId.slice(0, 3)}-INTAKE`,
    location_number: `9${runId.slice(0, 3)}`,
    name: `Intake ${runId}`,
    address_raw: "1 Test Way, Testville, CA 90000",
    region: "CA",
  });
  const priced = await insertOne("catalog_items", { sku: `IN-P-${runId}`, category: "service", name: `Intake priced ${runId}`, tax_class: "labor" });
  const unpriced = await insertOne("catalog_items", { sku: `IN-U-${runId}`, category: "part", name: `Intake unpriced ${runId}`, tax_class: "parts" });
  await must(admin.from("sell_prices").insert({ catalog_item_id: priced.id, market: "US", amount: 100, effective_from: "2026-01-01" }));
  const domain = await insertOne("customer_email_domains", { customer_id: customer.id, domain: `in-${runId.toLowerCase()}.example` });
  f = { shop: shopRow.id, customer: customer.id, location: location.id, priced: priced.id, unpriced: unpriced.id, domain: domain.id };
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopRow.id);
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
  const woIds: string[] = [];
  if (f) {
    await step("find work orders", async () => {
      woIds.push(...(await must(admin.from("work_orders").select("id").eq("customer_id", f.customer))).map((r: { id: string }) => r.id));
    });
  }
  await step("delete emails", () => must(admin.from("inbound_emails").delete().like("provider_message_id", `<intake-${runId}-%`)));
  if (woIds.length) {
    await step("delete sync rows", () => must(admin.from("integration_sync").delete().in("entity_id", woIds)));
    await step("delete work orders", () => must(admin.from("work_orders").delete().in("id", woIds)));
  }
  await step("delete logins", () => deleteLogins());
  if (f) {
    await step("delete domains", () => must(admin.from("customer_email_domains").delete().eq("customer_id", f.customer)));
    await step("delete locations", () => must(admin.from("customer_locations").delete().eq("customer_id", f.customer)));
    await step("delete catalog", () => must(admin.from("catalog_items").delete().in("id", [f.priced, f.unpriced])));
    await step("delete customer", () => must(admin.from("customers").delete().eq("id", f.customer)));
    await step("delete shop", () => must(admin.from("affiliates").delete().eq("id", f.shop)));
    const rowIds = [f.shop, f.customer, f.location, f.priced, f.unpriced, f.domain, cds?.id, shop?.id].filter((v): v is string => !!v);
    await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  }
  const { count } = await admin.from("inbound_emails").select("id", { count: "exact", head: true }).like("provider_message_id", `<intake-${runId}-%`);
  if (count) errors.push(`${count} emails left`);
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("access", () => {
  it("gives anonymous callers nothing", async () => {
    const client = anon();
    for (const table of ["inbound_emails", "customer_email_domains"]) {
      const { data, error } = await client.from(table).select("*");
      expect(error !== null || (data ?? []).length === 0).toBe(true);
    }
    const ins = await client.from("inbound_emails").insert({ provider_message_id: MSG(90), received_at: new Date().toISOString() });
    expect(ins.error).not.toBeNull();
    const rpc = await client.rpc("intake_create_draft_work_order", draftArgs("00000000-0000-0000-0000-000000000000"));
    expect(rpc.error).not.toBeNull();
  });

  it("gives shops nothing: no rows, no writes, no draft function", async () => {
    const email = await insertEmail(1);
    const read = await shop.client.from("inbound_emails").select("id").eq("id", email);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);
    const domains = await shop.client.from("customer_email_domains").select("id");
    expect(domains.data ?? []).toEqual([]);

    const ins = await shop.client.from("inbound_emails").insert({ provider_message_id: MSG(91), received_at: new Date().toISOString() });
    expect(ins.error).not.toBeNull();
    const upd = await shop.client.from("inbound_emails").update({ status: "ignored" }).eq("id", email).select("id");
    expect(upd.data ?? []).toEqual([]);
    const dom = await shop.client.from("customer_email_domains").insert({ customer_id: f.customer, domain: `shop-${runId.toLowerCase()}.example` });
    expect(dom.error).not.toBeNull();

    const rpc = await shop.client.rpc("intake_create_draft_work_order", draftArgs(email));
    expect(rpc.error?.code).toBe("42501");
    const after = await must(admin.from("inbound_emails").select("status, work_order_id").eq("id", email).single());
    expect(after).toEqual({ status: "new", work_order_id: null });
  });

  it("lets CDS staff read emails and domains", async () => {
    const email = await insertEmail(2);
    const read = await cds.client.from("inbound_emails").select("id").eq("id", email);
    expect(read.data).toHaveLength(1);
    const domains = await cds.client.from("customer_email_domains").select("id").eq("customer_id", f.customer);
    expect(domains.data).toHaveLength(1);
  });
});

describe("intake_create_draft_work_order", () => {
  it("creates a Pending Review draft from the service role, once", async () => {
    const email = await insertEmail(3);
    const first = await admin.rpc("intake_create_draft_work_order", draftArgs(email));
    expect(first.error).toBeNull();
    const wo = first.data as string;

    const order = await must(admin.from("work_orders").select("status, affiliate_id, fulfillment, unit_number, po_number, location_id").eq("id", wo).single());
    expect(order).toMatchObject({ status: "pending_review", affiliate_id: null, fulfillment: "pickup", unit_number: "100", po_number: "200", location_id: f.location });

    const internal = await must(
      admin.from("work_order_internal").select("source, inbound_email_id, auto_dispatched, review_reason, internal_notes").eq("work_order_id", wo).single(),
    );
    expect(internal).toMatchObject({ source: "email_import", inbound_email_id: email, auto_dispatched: false });
    expect(internal.internal_notes).toContain(`Not added (no customer price): IN-U-${runId}`);

    const lines = await must(admin.from("work_order_lines").select("catalog_item_id").eq("work_order_id", wo));
    expect(lines).toEqual([{ catalog_item_id: f.priced }]);

    const row = await must(admin.from("inbound_emails").select("status, work_order_id, error").eq("id", email).single());
    expect(row).toEqual({ status: "converted", work_order_id: wo, error: null });

    const again = await admin.rpc("intake_create_draft_work_order", draftArgs(email, { p_unit_number: "999" }));
    expect(again.data).toBe(wo);
    const count = await admin.from("work_order_internal").select("work_order_id", { count: "exact", head: true }).eq("inbound_email_id", email);
    expect(count.count).toBe(1);
  });

  it("works for CDS staff too", async () => {
    const email = await insertEmail(4);
    const r = await cds.client.rpc("intake_create_draft_work_order", draftArgs(email, { p_location: null, p_location_label: "Yard on Elm" }));
    expect(r.error).toBeNull();
    const order = await must(admin.from("work_orders").select("location_label, location_id").eq("id", r.data as string).single());
    expect(order).toEqual({ location_label: "Yard on Elm", location_id: null });
  });

  it("refuses an email marked as not a work request and a location of another customer", async () => {
    const ignored = await insertEmail(5, { status: "ignored" });
    expect((await admin.rpc("intake_create_draft_work_order", draftArgs(ignored))).error?.message).toMatch(/not a work request/);

    const other = await insertOne("customers", { code: `IN2-${runId}`, name: `Customer IN2 ${runId}` });
    try {
      const email = await insertEmail(6);
      const r = await admin.rpc("intake_create_draft_work_order", draftArgs(email, { p_customer: other.id }));
      expect(r.error?.message).toMatch(/does not belong to this customer/);
    } finally {
      await must(admin.from("customers").delete().eq("id", other.id));
      await must(admin.from("audit_log").delete().eq("row_id", other.id));
    }
  });

  it("is never auto-dispatched and the shop does not see it", async () => {
    const email = await insertEmail(7);
    const wo = (await admin.rpc("intake_create_draft_work_order", draftArgs(email))).data as string;
    const upd = await admin.from("work_order_internal").update({ auto_dispatched: true }).eq("work_order_id", wo);
    expect(upd.error?.code).toBe("23514");
    const seen = await shop.client.from("work_orders").select("id").eq("id", wo);
    expect(seen.data ?? []).toEqual([]);
  });
});

describe("template fields and Ryder PO paperwork", () => {
  it("stores the template fields: shop-facing on the order, contact and order type CDS-only", async () => {
    const email = await insertEmail(10);
    const r = await admin.rpc(
      "intake_create_draft_work_order",
      draftArgs(email, {
        p_vin: "1fujgldr5clzz1234",
        p_mileage: 287004,
        p_requested_date: "2026-10-22",
        p_return_to_location: true,
        p_order_type: "G14 Classified",
        p_customer_region: "Northeast",
        p_contact_name: "Robin Sample",
        p_contact_email: "Robin.Sample@Fleet.example",
        p_contact_phone: "(555) 010-2233",
      }),
    );
    expect(r.error).toBeNull();
    const wo = r.data as string;
    const order = await must(admin.from("work_orders").select("vin, mileage, requested_date, return_to_location").eq("id", wo).single());
    expect(order).toEqual({ vin: "1FUJGLDR5CLZZ1234", mileage: 287004, requested_date: "2026-10-22", return_to_location: true });
    const internal = await must(
      admin
        .from("work_order_internal")
        .select("order_type, customer_region, customer_contact_name, customer_contact_email, customer_contact_phone")
        .eq("work_order_id", wo)
        .single(),
    );
    expect(internal).toEqual({
      order_type: "G14 Classified",
      customer_region: "Northeast",
      customer_contact_name: "Robin Sample",
      customer_contact_email: "robin.sample@fleet.example",
      customer_contact_phone: "(555) 010-2233",
    });
    // A shop never reads work_order_internal.
    const shopRead = await shop.client.from("work_order_internal").select("customer_contact_email").eq("work_order_id", wo);
    expect(shopRead.data ?? []).toEqual([]);
    const bad = await admin.rpc("intake_create_draft_work_order", draftArgs(await insertEmail(11), { p_mileage: -1 }));
    expect(bad.error?.message).toMatch(/Mileage/);
  });

  it("notes Ryder PO paperwork once on the one open order with that PO", async () => {
    const po = `9${Date.now().toString().slice(-9)}`;
    const wo = (await admin.rpc("intake_create_draft_work_order", draftArgs(await insertEmail(12), { p_po_number: po }))).data as string;
    const paperwork = await insertEmail(13, { subject: `Ryder Purchase Order: PO # ${po} Issued for test`, status: "ignored" });

    expect((await shop.client.rpc("intake_note_po_reference", { p_email: paperwork, p_po: po })).error?.code).toBe("42501");
    const first = await cds.client.rpc("intake_note_po_reference", { p_email: paperwork, p_po: po });
    expect(first.error).toBeNull();
    expect(first.data).toEqual([expect.objectContaining({ work_order_id: wo })]);
    await must(admin.rpc("intake_note_po_reference", { p_email: paperwork, p_po: po }));
    const events = await must(admin.from("work_order_events").select("message, shop_visible").eq("work_order_id", wo).eq("event_type", "po_reference"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ shop_visible: false });
    expect(events[0].message).toContain(po);

    // No open order with the PO (the order is cancelled): nothing is noted.
    await must(admin.from("work_orders").update({ status: "cancelled" }).eq("id", wo));
    const none = await admin.rpc("intake_note_po_reference", { p_email: paperwork, p_po: po });
    expect(none.data).toEqual([]);
  });

  it("stores the inbox and In-Reply-To and reads them back for a reprocess", async () => {
    const store = supabaseIntakeStore(admin);
    const rec = await store.insertEmail(
      {
        messageId: MSG(14),
        from: "Tech <tech@xpo.example>",
        to: ["xpo@cds.direct"],
        subject: "DPF CLEANING PICKUP",
        receivedAt: new Date().toISOString(),
        text: "PO# 902814 UNIT # 0632-4471 METER 512880 PICK UP FOR CLEANING QTY. 1 A6809999 DPF MODULE",
        html: null,
        attachments: [],
        inReplyTo: "<earlier@xpo.example>",
      },
      "webhook",
    );
    const row = await must(admin.from("inbound_emails").select("mailbox, in_reply_to").eq("id", rec.id).single());
    expect(row).toEqual({ mailbox: "xpo@cds.direct", in_reply_to: "<earlier@xpo.example>" });
    const back = await store.getEmail(rec.id);
    expect(back?.email).toMatchObject({ deliveredTo: "xpo@cds.direct", inReplyTo: "<earlier@xpo.example>" });
  });
});

describe("idempotency in the table", () => {
  it("refuses a second row with the same message id", async () => {
    await insertEmail(8);
    const dup = await admin.from("inbound_emails").insert({ provider_message_id: MSG(8), received_at: new Date().toISOString() });
    expect(dup.error?.code).toBe("23505");
    const ignored = await admin
      .from("inbound_emails")
      .upsert({ provider_message_id: MSG(8), received_at: new Date().toISOString() }, { onConflict: "provider_message_id", ignoreDuplicates: true })
      .select("id");
    expect(ignored.error).toBeNull();
    expect(ignored.data).toEqual([]);
  });

  it("accepts only the new status values", async () => {
    const r = await admin.from("inbound_emails").insert({ provider_message_id: MSG(9), received_at: new Date().toISOString(), status: "created_wo" });
    expect(r.error?.code).toBe("23514");
  });
});
