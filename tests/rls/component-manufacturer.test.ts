/**
 * Manufacturer is a list (Sarah, CDS, 2026-11-20): shop_save_component takes CUMMINS, DETROIT,
 * VOLVO, ISUZU, NAVISTAR, INTERNATIONAL or N/A, or no manufacturer yet. A component saved
 * before the list keeps its typed value when it is saved again; it can only change to a choice
 * from the list. Rows already saved are not touched.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `MFR-${runId}`;
let shop: string;
let customer: string;
let shopLogin: Login;
let wo: string;

const save = (component: string | null, manufacturer: string | null) =>
  shopLogin.client.rpc("shop_save_component", {
    p_work_order: wo,
    p_component: component,
    p_type: "DOC",
    p_manufacturer: manufacturer,
    p_part_number: "PN-1",
    p_serial_number: "SN-1",
    p_dp_before: null,
    p_dp_after: null,
    p_weight_before_g: null,
    p_weight_after_g: null,
    p_result: "cleaned",
    p_result_note: null,
  });

const manufacturerOf = async (id: string) =>
  ((await must(admin.from("work_order_components").select("manufacturer").eq("id", id).single())) as { manufacturer: string | null }).manufacturer;

beforeAll(async () => {
  shop = ((await must(admin.from("affiliates").insert({ short_code: LABEL, display_name: `Manufacturer Shop ${runId}` }).select().single())) as { id: string }).id;
  customer = ((await must(admin.from("customers").insert({ code: LABEL, name: `Manufacturer Customer ${runId}` }).select().single())) as { id: string }).id;
  shopLogin = await createLogin("shop", shop);
  wo = (
    (await must(
      admin
        .from("work_orders")
        .insert({
          customer_id: customer,
          location_label: LABEL,
          fulfillment: "shipping",
          affiliate_id: shop,
          status: "in_process",
          request_type: "service",
          unit_number: "MFR-1",
          requested_work: "Test cleaning",
        })
        .select("id")
        .single(),
    )) as { id: string }
  ).id;
  await must(admin.from("work_order_internal").insert({ work_order_id: wo }));
}, 120_000);

afterAll(async () => {
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().eq("code", LABEL));
  await must(admin.from("affiliates").delete().eq("short_code", LABEL));
}, 120_000);

describe("shop_save_component manufacturer", () => {
  it("saves every choice on the list, and no manufacturer yet", async () => {
    const id = (await must(save(null, "CUMMINS"))) as string;
    expect(await manufacturerOf(id)).toBe("CUMMINS");
    for (const m of ["DETROIT", "VOLVO", "ISUZU", "NAVISTAR", "INTERNATIONAL", "N/A", null]) {
      await must(save(id, m));
      expect(await manufacturerOf(id), String(m)).toBe(m);
    }
  });

  it("refuses a new typed value, also in lower case", async () => {
    for (const m of ["Freightliner", "cummins"]) {
      const { error } = await save(null, m);
      expect(error?.message, m).toMatch(/Choose the manufacturer from the list/);
    }
  });

  it("keeps an older typed value when the component is saved again, and only lets it change to the list", async () => {
    const old = (await must(
      admin.from("work_order_components").insert({ work_order_id: wo, affiliate_id: shop, seq: 50, component_type: "DOC", manufacturer: "Freightliner" }).select("id").single(),
    )) as { id: string };
    await must(save(old.id, "Freightliner"));
    expect(await manufacturerOf(old.id)).toBe("Freightliner");

    const { error } = await save(old.id, "Paccar");
    expect(error?.message).toMatch(/Choose the manufacturer from the list/);
    expect(await manufacturerOf(old.id)).toBe("Freightliner");

    await must(save(old.id, "DETROIT"));
    expect(await manufacturerOf(old.id)).toBe("DETROIT");
    // Once changed to the list, the old typed value cannot come back.
    expect((await save(old.id, "Freightliner")).error?.message).toMatch(/Choose the manufacturer from the list/);
  });
});
