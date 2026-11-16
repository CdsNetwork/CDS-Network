/**
 * Reserving a label purchase or a pickup booking before ShipStation is called
 * (20261116030000_shipstation_claims.sql). One live claim per shipment (label) or per label
 * (pickup): a second claim, also two at the same moment, is refused until the first is
 * released; releasing needs the claim id; a shipment that already has a label in use, or a
 * label that already has a pickup, cannot be claimed; only CDS can claim or release.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 * Nothing here calls ShipStation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `CLAIM-${runId}`;
let shopId: string;
let customer: string;
let wo: string;
let cds: Login;
let otherCds: Login;
let shop: Login;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

const shipment = async () => (await insertOne("shipments", { work_order_id: wo, direction: "customer_to_affiliate" })).id;
const label = async (shipmentId: string) =>
  (
    await insertOne("shipment_labels", {
      shipment_id: shipmentId,
      work_order_id: wo,
      shipstation_label_id: `se-${runId}-${Math.random().toString(36).slice(2, 8)}`,
      shipstation_carrier_id: "se-7157832",
      carrier: "FedEx",
      service_code: "fedex_ground",
      is_test: false,
      ship_from_summary: "Ryder 0412, 4500 W Buckeye Rd, Phoenix AZ 85043",
    })
  ).id;

const claim = (login: Login, kind: string, target: string) => login.client.rpc("cds_claim_shipstation", { p_kind: kind, p_target: target });
const release = (login: Login, kind: string, target: string, id: string) =>
  login.client.rpc("cds_release_shipstation", { p_kind: kind, p_target: target, p_claim: id });

beforeAll(async () => {
  shopId = (await insertOne("affiliates", { short_code: `CLS-${runId}`, display_name: `Shop Claim ${runId}` })).id;
  customer = (await insertOne("customers", { code: `CLC-${runId}`, name: `Customer Claim ${runId}` })).id;
  wo = (
    await insertOne("work_orders", {
      customer_id: customer,
      location_label: LABEL,
      fulfillment: "shipping",
      affiliate_id: shopId,
      status: "accepted",
      unit_number: "C1",
      requested_work: "Test cleaning",
    })
  ).id;
  await must(admin.from("work_order_internal").insert({ work_order_id: wo }));
  cds = await createLogin("cds", null);
  otherCds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await deleteLogins();
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().eq("id", shopId);
}, 120_000);

describe("cds_claim_shipstation for a label", () => {
  it("gives one claim at a time, also to two requests at the same moment, until it is released", async () => {
    const s = await shipment();
    const both = await Promise.all([claim(cds, "label", s), claim(otherCds, "label", s)]);
    const won = both.filter((r) => !r.error);
    expect(won).toHaveLength(1);
    expect(both.find((r) => r.error)?.error?.message).toBe("A label is already being created for this shipment. Refresh in a moment.");
    const id = won[0].data as string;

    // Another id does not release it.
    await must(release(cds, "label", s, "00000000-0000-4000-8000-000000000000"));
    expect((await claim(cds, "label", s)).error?.message).toMatch(/already being created/);

    await must(release(cds, "label", s, id));
    const again = await must(claim(cds, "label", s));
    expect(again).not.toBe(id);
  });

  it("is refused for a shipment that already has a label in use", async () => {
    const s = await shipment();
    await label(s);
    expect((await claim(cds, "label", s)).error?.message).toBe("This shipment already has a label. Void it before creating another.");
  });

  it("is refused for a shop and an anonymous caller", async () => {
    const s = await shipment();
    expect((await claim(shop, "label", s)).error).not.toBeNull();
    expect((await anon().rpc("cds_claim_shipstation", { p_kind: "label", p_target: s })).error).not.toBeNull();
    // Nobody else's refusal left a claim behind.
    const id = await must(claim(cds, "label", s));
    expect(typeof id).toBe("string");
    expect((await release(shop, "label", s, id as string)).error).not.toBeNull();
  });
});

describe("cds_claim_shipstation for a pickup", () => {
  it("gives one claim per label, and none once the label has a pickup", async () => {
    const l = await label(await shipment());
    const id = (await must(claim(cds, "pickup", l))) as string;
    expect((await claim(otherCds, "pickup", l)).error?.message).toBe("A pickup is already being booked for this label. Refresh in a moment.");
    await must(release(cds, "pickup", l, id));
    await must(
      cds.client.rpc("cds_record_shipment_pickup", {
        p_label: l,
        p_pickup: {
          shipstation_pickup_id: `pik_${runId}`,
          confirmation_number: "C1",
          window_start: "2026-11-11T16:00:00.000Z",
          window_end: "2026-11-12T00:00:00.000Z",
          time_zone: "America/Phoenix",
          notes: null,
        },
      }),
    );
    expect((await claim(cds, "pickup", l)).error?.message).toBe("This label already has a pickup. Cancel it before booking another.");
  });
});
