/**
 * UPS by Worldwide Express (client decision 2026-11-13: rates from FedEx and UPS by WWEX side
 * by side). The migration adds CDS's WWEX carrier row (ShipStation carrier se-7177883,
 * carrier code wwex_parcel) turned on, with its domestic services, and marks it as a carrier
 * ShipStation cannot book pickups for. ShipStation's own UPS rates stay off. CDS reads the
 * rows; shops and anonymous callers see none of them.
 *
 * Nothing here changes the carrier rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

let cds: Login;
let shop: Login;
let shopId: string;

const WWEX = "se-7177883";
const WWEX_SERVICES = [
  ["wwex_ups_ground", "UPS Ground"],
  ["wwex_ups_3_day_select", "UPS 3 Day Select"],
  ["wwex_ups_2nd_day_air", "UPS 2nd Day Air"],
  ["wwex_ups_2nd_day_air_am", "UPS 2nd Day Air A.M."],
  ["wwex_ups_next_day_saver", "UPS Next Day Air Saver"],
  ["wwex_ups_next_day_air", "UPS Next Day Air"],
  ["wwex_ups_next_day_early", "UPS Next Day Air Early"],
].sort((a, b) => a[0].localeCompare(b[0]));

beforeAll(async () => {
  const s = await must(admin.from("affiliates").insert({ short_code: `WX-${runId}`, display_name: `Shop WWEX ${runId}` }).select().single());
  shopId = (s as { id: string }).id;
  cds = await createLogin("cds", null);
  shop = await createLogin("shop", shopId);
}, 120_000);

afterAll(async () => {
  await deleteLogins();
  await must(admin.from("affiliates").delete().eq("short_code", `WX-${runId}`));
  const ids = [cds?.id, shop?.id, shopId].filter((v): v is string => !!v);
  if (ids.length) await must(admin.from("audit_log").delete().in("row_id", ids));
}, 120_000);

describe("UPS by Worldwide Express carrier", () => {
  it("CDS reads the WWEX row: on, second in the list, UPS, no pickups through ShipStation", async () => {
    const row = await must(
      cds.client
        .from("shipping_carriers")
        .select("shipstation_carrier_id, carrier, name, active, sort_order, notes, api_pickups")
        .eq("shipstation_carrier_id", WWEX)
        .single(),
    );
    expect(row).toEqual({
      shipstation_carrier_id: WWEX,
      carrier: "UPS",
      name: "UPS by Worldwide Express",
      active: true,
      sort_order: 2,
      notes: "CDS's UPS account through Worldwide Express (contracted rates)",
      api_pickups: false,
    });
  });

  it("CDS reads the seven domestic WWEX services, all on", async () => {
    const rows = await must(
      cds.client
        .from("shipping_services")
        .select("service_code, name, active, shipping_carriers!inner(shipstation_carrier_id)")
        .eq("shipping_carriers.shipstation_carrier_id", WWEX)
        .order("service_code"),
    );
    expect((rows as { service_code: string; name: string; active: boolean }[]).map((r) => [r.service_code, r.name, r.active])).toEqual(
      WWEX_SERVICES.map(([code, name]) => [code, name, true]),
    );
  });

  it("FedEx and WWEX are the carriers that are on; ShipStation's own UPS rates stay off", async () => {
    const rows = await must(cds.client.from("shipping_carriers").select("shipstation_carrier_id, active, api_pickups").order("sort_order"));
    const byId = new Map((rows as { shipstation_carrier_id: string; active: boolean; api_pickups: boolean }[]).map((r) => [r.shipstation_carrier_id, r]));
    expect(byId.get("se-7157832")).toMatchObject({ active: true, api_pickups: true });
    expect(byId.get("se-7157770")).toMatchObject({ active: false });
    expect(byId.get(WWEX)).toMatchObject({ active: true });
  });

  it("shops and anonymous callers see no carrier or service rows", async () => {
    for (const client of [shop.client, anon()]) {
      const carriers = await client.from("shipping_carriers").select("id").eq("shipstation_carrier_id", WWEX);
      expect(carriers.data ?? []).toEqual([]);
      const services = await client.from("shipping_services").select("id").like("service_code", "wwex_%");
      expect(services.data ?? []).toEqual([]);
    }
  });
});
