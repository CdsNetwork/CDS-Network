/**
 * The database side of the status emails to CDS (src/lib/portal-email-store.ts), run with the
 * service role like the server does: reads the order and its status change, keys a change so a
 * double clicked dispatch is emailed once, and records the outcome in integration_sync.
 * Nothing is sent: emails are off (no PORTAL_EMAILS_ENABLED) in these tests.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifyWorkOrderEvent } from "@/lib/portal-email";
import { supabasePortalEmailStore } from "@/lib/portal-email-store";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `PE-${runId}`;
const suffix = `%-${runId}`;
let shop: string;
let customer: string;
let shopLogin: Login;
let wo: string;
const store = supabasePortalEmailStore(admin);

async function insertOne(table: string, row: Record<string, unknown>): Promise<{ id: string }> {
  return must(admin.from(table).insert(row).select("id").single()) as Promise<{ id: string }>;
}

const event = (event_type: string, from_status: string, to_status: string, message: string) =>
  must(admin.from("work_order_events").insert({ work_order_id: wo, event_type, from_status, to_status, message, shop_visible: true }));

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `PA-${runId}`, display_name: `Shop PE ${runId}` })).id;
  customer = (await insertOne("customers", { code: `PC-${runId}`, name: `Customer PE ${runId}` })).id;
  wo = (
    await insertOne("work_orders", {
      customer_id: customer,
      location_label: LABEL,
      affiliate_id: shop,
      status: "awaiting_acceptance",
      unit_number: "U-PE",
      po_number: "PO-PE",
      requested_work: "Test cleaning",
    })
  ).id;
  await must(admin.from("work_order_internal").insert({ work_order_id: wo }));
  await event("create", "pending_review", "pending_review", "Created");
  await event("dispatch", "pending_review", "awaiting_acceptance", `Approved and dispatched to Shop PE ${runId}`);
  shopLogin = await createLogin("shop", shop);
}, 120_000);

afterAll(async () => {
  if (wo) await must(admin.from("integration_sync").delete().eq("entity_id", wo));
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
  await must(admin.from("audit_log").delete().in("row_id", [wo, shop, customer, shopLogin?.id].filter(Boolean)));
}, 120_000);

describe("portal email store", () => {
  it("reads the order, customer, shop and the dispatch", async () => {
    const d = await store.details("sent", wo);
    expect(d).toMatchObject({
      workOrderId: wo,
      customer: `Customer PE ${runId}`,
      location: LABEL,
      unitNumber: "U-PE",
      poNumber: "PO-PE",
      shop: `Shop PE ${runId}`,
    });
    expect(d?.key).toMatch(new RegExp(`^sent:${shop}:\\d+$`));
  });

  it("gives a double clicked dispatch the same key, and claims it once", async () => {
    const before = await store.details("sent", wo);
    await event("dispatch", "awaiting_acceptance", "awaiting_acceptance", `Approved and dispatched to Shop PE ${runId}`);
    const after = await store.details("sent", wo);
    expect(after?.key).toBe(before?.key);

    const [a, b] = await Promise.all([store.claim("sent", wo, after!.key), store.claim("sent", wo, after!.key)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const rows = await must(admin.from("integration_sync").select("status, system, entity, external_id").eq("entity_id", wo).order("id"));
    expect(rows.map((r) => r.status).sort()).toEqual(["duplicate", "sending"]);
    expect(rows[0]).toMatchObject({ system: "email", entity: "portal_email", external_id: after!.key });
    await store.finish((a ?? b)!.rowId, "ok", "test");
  });

  it("reads the shop's decline reason after a real decline, under a new key, and records a skipped email", async () => {
    await must(shopLogin.client.rpc("shop_decline_work_order", { p_work_order: wo, p_reason: "No oven time this week" }));
    const d = await store.details("declined", wo);
    expect(d?.declineReason).toBe("No oven time this week");
    expect(d?.key).toMatch(/^declined:/);

    const out = await notifyWorkOrderEvent("declined", wo, { store, env: {} });
    expect(out.status).toBe("skipped");
    const again = await notifyWorkOrderEvent("declined", wo, { store, env: {} });
    expect(again.status).toBe("duplicate");
    const rows = await must(admin.from("integration_sync").select("status, external_id").eq("entity_id", wo).eq("external_id", d!.key));
    expect(rows.map((r) => r.status).sort()).toEqual(["duplicate", "skipped"]);
  });

  it("finds nothing for a change that did not happen", async () => {
    expect(await store.details("finished", wo)).toBeNull();
  });
});
