/**
 * Shop isolation: a shop login, talking to the real API with its own session, must not
 * read another shop's work orders, any customer price, customer override or margin.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards,
 * so the suite can run against a local stack or a staging project.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, anon, createLogin, deleteLogin, deleteLogins, must, runId, url, type Login } from "./helpers";

type Fixture = {
  shopA: string;
  shopB: string;
  customerX: string;
  customerY: string;
  service: string;
  part: string;
  woA: string;
  woAPending: string;
  woB: string;
  linesA: string[];
  linesB: string[];
  locationY: string;
  files: string[];
};

let f: Fixture;
let cds: Login;
let shopA: Login;
let shopB: Login;

const CDS_ONLY_TABLES = [
  "sell_prices",
  "customer_price_overrides",
  "work_order_line_pricing",
  "work_order_financials",
  "work_order_internal",
  "shipment_internal",
  "authorization_decisions",
  "customer_billing",
  "customer_locations",
  "affiliate_internal",
  "affiliate_contacts",
  "tax_rates",
  "app_settings",
  "audit_log",
  "inbound_emails",
  "integration_sync",
  "shipment_tracking_events",
] as const;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function buildFixture(): Promise<Fixture> {
  const shopARow = await insertOne("affiliates", { short_code: `A-${runId}`, display_name: `Shop A ${runId}` });
  const shopBRow = await insertOne("affiliates", { short_code: `B-${runId}`, display_name: `Shop B ${runId}` });
  await must(
    admin.from("affiliate_internal").insert([
      { affiliate_id: shopARow.id, tax_registration: "A-REG", notes: "internal A" },
      { affiliate_id: shopBRow.id, tax_registration: "B-REG", notes: "internal B" },
    ]),
  );
  await must(
    admin.from("affiliate_contacts").insert([
      { affiliate_id: shopARow.id, email: `a-${runId.toLowerCase()}@test.invalid` },
      { affiliate_id: shopBRow.id, email: `b-${runId.toLowerCase()}@test.invalid` },
    ]),
  );

  const customerX = await insertOne("customers", { code: `X-${runId}`, name: `Customer X ${runId}` });
  const customerY = await insertOne("customers", { code: `Y-${runId}`, name: `Customer Y ${runId}` });
  await must(
    admin.from("customer_billing").insert([
      { customer_id: customerX.id, billing_email: `x-${runId.toLowerCase()}@test.invalid` },
      { customer_id: customerY.id, billing_email: `y-${runId.toLowerCase()}@test.invalid` },
    ]),
  );
  const locationY = await insertOne("customer_locations", {
    customer_id: customerY.id,
    code: `LOC-${runId}`,
    name: "Test yard",
    address_raw: "1 Test St Testville CA 90000",
    default_affiliate_id: shopBRow.id,
    fulfillment: "shipping",
  });

  const service = await insertOne("catalog_items", {
    sku: `SVC-${runId}`,
    category: "service",
    name: "Test cleaning",
    tax_class: "labor",
  });
  const part = await insertOne("catalog_items", {
    sku: `PRT-${runId}`,
    category: "gasket",
    name: "Test gasket",
    tax_class: "parts",
  });

  const from = "2026-01-01";
  await must(
    admin.from("shop_rates").insert([
      { catalog_item_id: service.id, amount: 200, effective_from: from },
      { catalog_item_id: part.id, amount: 10, effective_from: from },
      // Shop B has its own, higher service rate. Shop A must never see it.
      { catalog_item_id: service.id, affiliate_id: shopBRow.id, amount: 210, effective_from: from },
    ]),
  );
  await must(
    admin.from("sell_prices").insert([
      { catalog_item_id: service.id, amount: 300, effective_from: from },
      { catalog_item_id: part.id, amount: 12, effective_from: from },
    ]),
  );
  await must(
    admin.from("customer_price_overrides").insert({
      customer_id: customerX.id,
      catalog_item_id: service.id,
      amount: 280,
      effective_from: from,
    }),
  );

  const wo = (affiliate: string | null, customer: string, status: string, unit: string) => ({
    customer_id: customer,
    location_label: `TEST-${runId}`,
    site_address: "1 Test St Testville CA 90000",
    fulfillment: "shipping",
    affiliate_id: affiliate,
    status,
    unit_number: unit,
    po_number: `PO-${runId}`,
    requested_work: "Test cleaning",
  });
  const woA = await insertOne("work_orders", wo(shopARow.id, customerX.id, "awaiting_acceptance", "A-1"));
  const woAPending = await insertOne("work_orders", wo(shopARow.id, customerX.id, "pending_review", "A-2"));
  const woB = await insertOne("work_orders", wo(shopBRow.id, customerY.id, "accepted", "B-1"));

  await must(
    admin.from("work_order_internal").insert(
      [woA, woAPending, woB].map((w) => ({
        work_order_id: w.id,
        internal_notes: `internal note ${w.id}`,
        review_reason: "test",
        tax_rate: 7.25,
      })),
    ),
  );

  const linesA = await must(
    admin
      .from("work_order_lines")
      .insert([
        { work_order_id: woA.id, catalog_item_id: service.id, qty: 1 },
        { work_order_id: woA.id, catalog_item_id: part.id, qty: 2 },
        { work_order_id: woAPending.id, catalog_item_id: service.id, qty: 1 },
      ])
      .select("id"),
  );
  const linesB = await must(
    admin
      .from("work_order_lines")
      .insert([
        { work_order_id: woB.id, catalog_item_id: service.id, qty: 1 },
        { work_order_id: woB.id, catalog_item_id: part.id, qty: 1 },
      ])
      .select("id"),
  );

  for (const w of [woA, woB]) {
    const shipment = await insertOne("shipments", {
      work_order_id: w.id,
      direction: "customer_to_affiliate",
      carrier: "UPS",
      tracking_number: `1Z${runId}${w.id.slice(0, 6)}`,
    });
    await must(admin.from("shipment_internal").insert({ shipment_id: shipment.id, quoted_cost: 40, actual_cost: 40, notes: "internal" }));
  }

  await must(
    admin.from("work_order_events").insert([
      { work_order_id: woA.id, event_type: "dispatch", message: "visible to A", shop_visible: true },
      { work_order_id: woA.id, event_type: "note", message: "internal to CDS", shop_visible: false },
      { work_order_id: woB.id, event_type: "dispatch", message: "visible to B", shop_visible: true },
    ]),
  );

  await must(
    admin.from("work_order_components").insert([
      { work_order_id: woA.id, seq: 1, component_type: "DPF", serial_number: `SN-A-${runId}` },
      { work_order_id: woB.id, seq: 1, component_type: "DPF", serial_number: `SN-B-${runId}` },
    ]),
  );

  await must(
    admin.from("authorization_requests").insert({
      work_order_id: woB.id,
      seq: 1,
      kind: "service",
      catalog_item_id: service.id,
      note: "B asks for extra work",
    }),
  );

  const files = [`${woA.id}/visible.txt`, `${woA.id}/hidden.txt`, `${woB.id}/visible.txt`];
  for (const path of files) {
    const { error } = await admin.storage
      .from("wo-files")
      .upload(path, new Blob([`file ${path}`], { type: "text/plain" }), { upsert: true });
    if (error) throw error;
  }
  await must(
    admin.from("attachments").insert([
      { work_order_id: woA.id, category: "other", storage_path: files[0], file_name: "visible.txt", shop_visible: true },
      { work_order_id: woA.id, category: "other", storage_path: files[1], file_name: "hidden.txt", shop_visible: false },
      { work_order_id: woB.id, category: "other", storage_path: files[2], file_name: "visible.txt", shop_visible: true },
    ]),
  );

  return {
    shopA: shopARow.id,
    shopB: shopBRow.id,
    customerX: customerX.id,
    customerY: customerY.id,
    service: service.id,
    part: part.id,
    woA: woA.id,
    woAPending: woAPending.id,
    woB: woB.id,
    linesA: linesA.map((l: { id: string }) => l.id),
    linesB: linesB.map((l: { id: string }) => l.id),
    locationY: locationY.id,
    files,
  };
}

/** Removes everything this run created, found by run id, so a half-built fixture is cleaned too. */
async function removeFixture(): Promise<void> {
  const wos = await must(admin.from("work_orders").select("id").eq("location_label", `TEST-${runId}`));
  const woIds = wos.map((w: { id: string }) => w.id);
  for (const id of woIds) {
    const { data: objects } = await admin.storage.from("wo-files").list(id);
    if (objects?.length) await admin.storage.from("wo-files").remove(objects.map((o) => `${id}/${o.name}`));
  }
  if (woIds.length) await must(admin.from("work_orders").delete().in("id", woIds));
  await deleteLogins();
  await must(admin.from("customer_locations").delete().eq("code", `LOC-${runId}`));
  await must(admin.from("customers").delete().in("code", [`X-${runId}`, `Y-${runId}`]));
  await must(admin.from("catalog_items").delete().in("sku", [`SVC-${runId}`, `PRT-${runId}`]));
  await must(admin.from("affiliates").delete().in("short_code", [`A-${runId}`, `B-${runId}`]));
}

/** Rows a client can see among this run's work orders. */
async function visibleWorkOrders(client: SupabaseClient): Promise<string[]> {
  const rows = await must(client.from("work_orders").select("id").in("id", [f.woA, f.woAPending, f.woB]));
  return (rows ?? []).map((r: { id: string }) => r.id).sort();
}

beforeAll(async () => {
  try {
    f = await buildFixture();
    cds = await createLogin("cds", null);
    shopA = await createLogin("shop", f.shopA);
    shopB = await createLogin("shop", f.shopB);
  } catch (error) {
    await removeFixture();
    throw error;
  }
}, 120_000);

afterAll(async () => {
  await removeFixture();
}, 120_000);

describe("shop login: work orders", () => {
  it("sees its own dispatched work order and nothing else", async () => {
    expect(await visibleWorkOrders(shopA.client)).toEqual([f.woA]);
    expect(await visibleWorkOrders(shopB.client)).toEqual([f.woB]);
  });

  it("cannot fetch another shop's work order by id", async () => {
    const { data, error } = await shopA.client.from("work_orders").select("*").eq("id", f.woB).maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("cannot see its own work order while it is pending CDS review", async () => {
    const rows = await must(shopA.client.from("work_orders").select("id").eq("id", f.woAPending));
    expect(rows).toEqual([]);
  });

  it("cannot read another shop's lines, components, shipments, requests, events or attachments", async () => {
    for (const table of [
      "work_order_lines",
      "work_order_components",
      "shipments",
      "authorization_requests",
      "work_order_events",
      "attachments",
    ]) {
      const rows = await must(shopA.client.from(table).select("*").eq("work_order_id", f.woB));
      expect(rows, table).toEqual([]);
    }
  });

  it("reads lines of its own work order with its pay rate, but no customer price", async () => {
    const rows = await must(
      shopA.client.from("work_order_lines").select("*").in("work_order_id", [f.woA, f.woAPending, f.woB]),
    );
    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([...f.linesA.slice(0, 2)].sort());
    for (const row of rows as Record<string, unknown>[]) {
      expect(Object.keys(row)).not.toContain("customer_unit_price");
    }
    const rates = (rows as { catalog_item_id: string; shop_unit_rate: string }[])
      .map((r) => [r.catalog_item_id === f.service ? "service" : "part", Number(r.shop_unit_rate)])
      .sort();
    expect(rates).toEqual([
      ["part", 10],
      ["service", 200],
    ]);
  });

  it("gets nothing when it embeds line pricing through the API", async () => {
    const rows = await must(
      shopA.client
        .from("work_order_lines")
        .select("id, work_order_line_pricing(customer_unit_price, price_source)")
        .eq("work_order_id", f.woA),
    );
    expect(rows.length).toBe(2);
    for (const row of rows as { work_order_line_pricing: unknown }[]) {
      expect(row.work_order_line_pricing).toBeNull();
    }
  });

  it("sees only shop-visible events and attachments on its own work order", async () => {
    const events = await must(shopA.client.from("work_order_events").select("message").eq("work_order_id", f.woA));
    expect(events).toEqual([{ message: "visible to A" }]);
    const files = await must(shopA.client.from("attachments").select("file_name").eq("work_order_id", f.woA));
    expect(files).toEqual([{ file_name: "visible.txt" }]);
  });
});

describe("shop login: prices, overrides and margins", () => {
  for (const table of CDS_ONLY_TABLES) {
    it(`reads zero rows from ${table}`, async () => {
      const { data, error } = await shopA.client.from(table).select("*").limit(5);
      // Either RLS filters every row or the request is refused; both are acceptable.
      expect(error ? [] : data).toEqual([]);
    });
  }

  it("cannot read sell prices or overrides even for its own work order's items", async () => {
    const prices = await must(shopA.client.from("sell_prices").select("*").in("catalog_item_id", [f.service, f.part]));
    const overrides = await must(
      shopA.client.from("customer_price_overrides").select("*").eq("customer_id", f.customerX),
    );
    expect(prices).toEqual([]);
    expect(overrides).toEqual([]);
  });

  it("gets no margin row for its own work order", async () => {
    const rows = await must(shopA.client.from("work_order_financials").select("*").eq("work_order_id", f.woA));
    expect(rows).toEqual([]);
  });

  it("sees the default shop rates and never another shop's own rate", async () => {
    const rows = await must(
      shopA.client.from("shop_rates").select("affiliate_id, amount").in("catalog_item_id", [f.service, f.part]),
    );
    expect(rows.every((r: { affiliate_id: string | null }) => r.affiliate_id === null)).toBe(true);
    expect(rows.map((r: { amount: string }) => Number(r.amount)).sort((a, b) => a - b)).toEqual([10, 200]);
  });

  it("sees only its own shop record and its own profile", async () => {
    const shops = await must(shopA.client.from("affiliates").select("id").in("id", [f.shopA, f.shopB]));
    expect(shops).toEqual([{ id: f.shopA }]);
    const profiles = await must(shopA.client.from("profiles").select("id").in("id", [cds.id, shopA.id, shopB.id]));
    expect(profiles).toEqual([{ id: shopA.id }]);
  });

  it("sees the customer name on its own work order only", async () => {
    const rows = await must(shopA.client.from("customers").select("id").in("id", [f.customerX, f.customerY]));
    expect(rows).toEqual([{ id: f.customerX }]);
  });

  it("cannot call the internal helper functions", async () => {
    for (const fn of ["is_cds", "my_affiliate", "shop_rate_for", "shop_can_see_wo"]) {
      const { error } = await shopA.client.rpc(fn);
      expect(error, fn).not.toBeNull();
    }
  });
});

describe("shop login: writes", () => {
  it("cannot reassign or change the status of its own work order", async () => {
    const { data } = await shopA.client
      .from("work_orders")
      .update({ affiliate_id: f.shopB, status: "completed", affiliate_invoice_ref: "X" })
      .eq("id", f.woA)
      .select();
    expect(data ?? []).toEqual([]);
    const row = await must(admin.from("work_orders").select("affiliate_id, status").eq("id", f.woA).single());
    expect(row).toEqual({ affiliate_id: f.shopA, status: "awaiting_acceptance" });
  });

  it("cannot insert work orders, lines or prices", async () => {
    const wo = await shopA.client.from("work_orders").insert({
      customer_id: f.customerX,
      location_label: "x",
      unit_number: "x",
      requested_work: "x",
      affiliate_id: f.shopA,
      status: "accepted",
    });
    expect(wo.error).not.toBeNull();

    const line = await shopA.client
      .from("work_order_lines")
      .insert({ work_order_id: f.woA, catalog_item_id: f.service, qty: 5, shop_unit_rate: 9999 });
    expect(line.error).not.toBeNull();

    const price = await shopA.client
      .from("shop_rates")
      .insert({ catalog_item_id: f.service, affiliate_id: f.shopA, amount: 9999 });
    expect(price.error).not.toBeNull();
  });

  it("cannot delete its own work order or change its pay rate", async () => {
    await shopA.client.from("work_orders").delete().eq("id", f.woA);
    await shopA.client.from("work_order_lines").update({ shop_unit_rate: 9999 }).eq("id", f.linesA[0]);
    const wo = await must(admin.from("work_orders").select("id").eq("id", f.woA));
    expect(wo.length).toBe(1);
    const line = await must(admin.from("work_order_lines").select("shop_unit_rate").eq("id", f.linesA[0]).single());
    expect(Number(line.shop_unit_rate)).toBe(200);
  });

  it("cannot edit its own profile to become CDS or another shop", async () => {
    await shopA.client.from("profiles").update({ kind: "cds", affiliate_id: null }).eq("id", shopA.id);
    await shopA.client.from("profiles").update({ affiliate_id: f.shopB }).eq("id", shopA.id);
    const row = await must(admin.from("profiles").select("kind, affiliate_id").eq("id", shopA.id).single());
    expect(row).toEqual({ kind: "shop", affiliate_id: f.shopA });
  });
});

describe("shop login: files", () => {
  it("downloads a shop-visible file of its own work order", async () => {
    const { data, error } = await shopA.client.storage.from("wo-files").download(f.files[0]);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(`file ${f.files[0]}`);
  });

  it("cannot download another shop's file or a CDS-only file", async () => {
    for (const path of [f.files[1], f.files[2]]) {
      const { data, error } = await shopA.client.storage.from("wo-files").download(path);
      expect(error, path).not.toBeNull();
      expect(data, path).toBeNull();
    }
  });
});

describe("reassignment and dispatch (review findings)", () => {
  const newWo = async (affiliate: string | null, status: string, unit: string) =>
    insertOne("work_orders", {
      customer_id: f.customerY,
      location_label: `TEST-${runId}`,
      fulfillment: "shipping",
      affiliate_id: affiliate,
      status,
      unit_number: unit,
      requested_work: "Test cleaning",
    });

  const ratesSeenBy = async (client: SupabaseClient, wo: string) =>
    (await must(client.from("work_order_lines").select("shop_unit_rate").eq("work_order_id", wo))).map(
      (r: { shop_unit_rate: string }) => Number(r.shop_unit_rate),
    );

  it("never shows the new shop the previous shop's own rate after reassignment", async () => {
    const wo = await newWo(f.shopB, "accepted", "R-1");
    await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.service, qty: 1 }));
    expect(await ratesSeenBy(shopB.client, wo.id)).toEqual([210]);

    await must(cds.client.from("work_orders").update({ affiliate_id: f.shopA }).eq("id", wo.id));
    expect(await ratesSeenBy(shopA.client, wo.id)).toEqual([200]);
    expect(await ratesSeenBy(shopB.client, wo.id)).toEqual([]);
  });

  it("applies the shop's own rate to lines added before dispatch", async () => {
    const wo = await newWo(null, "pending_review", "R-2");
    await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.service, qty: 1 }));
    await must(
      cds.client.from("work_orders").update({ affiliate_id: f.shopB, status: "awaiting_acceptance" }).eq("id", wo.id),
    );
    expect(await ratesSeenBy(shopB.client, wo.id)).toEqual([210]);
  });

  it("ignores a pay rate supplied by anyone but CDS when a line is inserted", async () => {
    const wo = await newWo(f.shopA, "accepted", "R-3");
    const [line] = await must(
      admin
        .from("work_order_lines")
        .insert({ work_order_id: wo.id, catalog_item_id: f.service, qty: 1, shop_unit_rate: 9999 })
        .select("shop_unit_rate"),
    );
    expect(Number(line.shop_unit_rate)).toBe(200);
  });
});

describe("inactive or incomplete logins (review findings)", () => {
  it("a shop whose affiliate is deactivated reads nothing", async () => {
    const shopC = await insertOne("affiliates", { short_code: `C-${runId}`, display_name: `Shop C ${runId}` });
    let login: Login | undefined;
    try {
      login = await createLogin("shop", shopC.id);
      await insertOne("work_orders", {
        customer_id: f.customerY,
        location_label: `TEST-${runId}`,
        fulfillment: "shipping",
        affiliate_id: shopC.id,
        status: "accepted",
        unit_number: "C-1",
        requested_work: "Test cleaning",
      });
      expect((await must(login.client.from("work_orders").select("id"))).length).toBe(1);

      await must(admin.from("affiliates").update({ active: false }).eq("id", shopC.id));
      expect(await must(login.client.from("work_orders").select("id"))).toEqual([]);
      expect(await must(login.client.from("shop_rates").select("id").limit(1))).toEqual([]);
    } finally {
      await admin.from("work_orders").delete().eq("affiliate_id", shopC.id);
      if (login) await deleteLogin(login.id);
      await admin.from("affiliates").delete().eq("id", shopC.id);
    }
  });

  it("a login without a profile reads nothing", async () => {
    const email = `rls-noprofile-${runId.toLowerCase()}@test.invalid`;
    const password = `${runId}-${Math.random().toString(36).slice(2)}-Aa1!`;
    const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    try {
      const client = anon();
      await client.auth.signInWithPassword({ email, password });
      for (const table of ["work_orders", "work_order_lines", "catalog_items", "shop_rates", "customers"]) {
        expect(await must(client.from(table).select("*").limit(1)), table).toEqual([]);
      }
    } finally {
      if (data.user) await admin.auth.admin.deleteUser(data.user.id);
    }
  });
});

describe("shop login: storage writes and GraphQL (review findings)", () => {
  it("cannot upload, overwrite or remove files, even on its own work order", async () => {
    const upload = await shopA.client.storage
      .from("wo-files")
      .upload(`${f.woA}/new.txt`, new Blob(["x"], { type: "text/plain" }));
    expect(upload.error).not.toBeNull();

    const overwrite = await shopA.client.storage
      .from("wo-files")
      .upload(f.files[0], new Blob(["changed"], { type: "text/plain" }), { upsert: true });
    expect(overwrite.error).not.toBeNull();

    await shopA.client.storage.from("wo-files").remove([f.files[0]]);
    const { data } = await admin.storage.from("wo-files").download(f.files[0]);
    expect(await data?.text()).toBe(`file ${f.files[0]}`);
  });

  it("reads no CDS-only data and no schema through GraphQL", async () => {
    const { data: session } = await shopA.client.auth.getSession();
    const res = await fetch(`${url}/graphql/v1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: process.env.SUPABASE_ANON_KEY!,
        authorization: `Bearer ${session.session?.access_token}`,
      },
      body: JSON.stringify({
        query: "{ sell_pricesCollection { edges { node { amount } } } __schema { types { name } } }",
      }),
    });
    const body = await res.json().catch(() => ({}));
    const text = JSON.stringify(body);
    expect(text).not.toContain('"amount"');
    expect(text).not.toContain("sell_prices");
  });
});

describe("CDS decisions 2026-10-14: declining jobs, no internal notes", () => {
  it("a shop can decline a job; it goes back to CDS and the shop no longer sees it", async () => {
    const wo = await insertOne("work_orders", {
      customer_id: f.customerX,
      location_label: `TEST-${runId}`,
      fulfillment: "shipping",
      affiliate_id: f.shopA,
      status: "awaiting_acceptance",
      unit_number: "D-1",
      requested_work: "Test cleaning",
    });
    await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));

    const noReason = await shopA.client.rpc("shop_decline_work_order", { p_work_order: wo.id, p_reason: " " });
    expect(noReason.error?.message).toMatch(/why/i);

    await must(shopA.client.rpc("shop_decline_work_order", { p_work_order: wo.id, p_reason: "No capacity this week" }));
    expect(await must(shopA.client.from("work_orders").select("id").eq("id", wo.id))).toEqual([]);

    const row = await must(cds.client.from("work_orders").select("status").eq("id", wo.id).single());
    expect(row.status).toBe("rejected_by_affiliate");
    const internal = await must(
      cds.client.from("work_order_internal").select("review_reason").eq("work_order_id", wo.id).single(),
    );
    expect(internal.review_reason).toContain("No capacity this week");
  });

  it("another shop cannot decline a job that is not theirs", async () => {
    const { error } = await shopB.client.rpc("shop_decline_work_order", { p_work_order: f.woA, p_reason: "x" });
    expect(error).not.toBeNull();
    const row = await must(admin.from("work_orders").select("status").eq("id", f.woA).single());
    expect(row.status).toBe("awaiting_acceptance");
  });

  it("shipments and extra work requests carry no CDS notes for the shop", async () => {
    const shipments = await must(shopA.client.from("shipments").select("*").eq("work_order_id", f.woA));
    expect(shipments.length).toBe(1);
    expect(Object.keys(shipments[0])).not.toContain("notes");

    const requests = await must(shopB.client.from("authorization_requests").select("*").eq("work_order_id", f.woB));
    expect(requests.length).toBe(1);
    for (const key of ["decision_note", "customer_approved_by_name"]) {
      expect(Object.keys(requests[0])).not.toContain(key);
    }
  });
});

describe("anonymous visitor", () => {
  it("reads nothing at all", async () => {
    const client = anon();
    for (const table of ["work_orders", "work_order_lines", "catalog_items", "shop_rates", ...CDS_ONLY_TABLES]) {
      const { data, error } = await client.from(table).select("*").limit(1);
      expect(error ? [] : data, table).toEqual([]);
    }
  });
});

describe("CDS login", () => {
  it("sees every work order, including pending review", async () => {
    expect(await visibleWorkOrders(cds.client)).toEqual([f.woA, f.woAPending, f.woB].sort());
  });

  it("sees margin as customer price minus shop rate, before tax, minus shipping", async () => {
    const rows = await must(
      cds.client
        .from("work_order_financials")
        .select("work_order_id, customer_subtotal, shop_subtotal, shipping_cost, margin_before_shipping, margin")
        .in("work_order_id", [f.woA, f.woB]),
    );
    const byId = Object.fromEntries(
      (rows as Record<string, string>[]).map((r) => [
        r.work_order_id,
        [r.customer_subtotal, r.shop_subtotal, r.shipping_cost, r.margin_before_shipping, r.margin].map(Number),
      ]),
    );
    // A: customer X override 280 + 2 x 12 = 304; shop 200 + 2 x 10 = 220; shipping 40.
    expect(byId[f.woA]).toEqual([304, 220, 40, 84, 44]);
    // B: fleet 300 + 12 = 312; shop B's own rate 210 + 10 = 220; shipping 40.
    expect(byId[f.woB]).toEqual([312, 220, 40, 92, 52]);
  });

  it("keeps prices snapshotted on existing lines when the price list changes", async () => {
    await must(admin.from("sell_prices").update({ amount: 99 }).eq("catalog_item_id", f.part));
    await must(admin.from("shop_rates").update({ amount: 50 }).eq("catalog_item_id", f.part));
    try {
      const pricing = await must(
        cds.client.from("work_order_line_pricing").select("customer_unit_price").eq("line_id", f.linesA[1]).single(),
      );
      expect(Number(pricing.customer_unit_price)).toBe(12);
      const line = await must(cds.client.from("work_order_lines").select("shop_unit_rate").eq("id", f.linesA[1]).single());
      expect(Number(line.shop_unit_rate)).toBe(10);
    } finally {
      // Later tests rely on the fixture prices.
      await must(admin.from("sell_prices").update({ amount: 12 }).eq("catalog_item_id", f.part));
      await must(admin.from("shop_rates").update({ amount: 10 }).eq("catalog_item_id", f.part));
    }
  });
});

describe("QA round 1 regressions (2026-10-15)", () => {
  const newWo = async (affiliate: string | null, status: string, unit: string, fulfillment = "shipping") => {
    const wo = await insertOne("work_orders", {
      customer_id: f.customerX,
      location_label: `TEST-${runId}`,
      fulfillment,
      affiliate_id: affiliate,
      status,
      unit_number: unit,
      requested_work: "Test cleaning",
    });
    await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
    return wo;
  };

  it("BUG-1: after reassignment the new shop sees no history naming the previous shop", async () => {
    const wo = await newWo(null, "pending_review", "Q1-1");
    await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.service, qty: 1 }));
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: wo.id, p_affiliate: f.shopA }));
    await must(cds.client.rpc("cds_set_status", { p_work_order: wo.id, p_status: "pending_review", p_note: null }));
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: wo.id, p_affiliate: f.shopB }));

    const events = await must(shopB.client.from("work_order_events").select("message").eq("work_order_id", wo.id));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events as { message: string }[]) {
      expect(e.message).not.toContain(`Shop A ${runId}`);
    }
  });

  it("BUG-2: a job moved to another shop does not show the previous shop's work", async () => {
    const wo = await newWo(f.shopA, "awaiting_acceptance", "Q1-2");
    await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.service, qty: 1 }));
    await must(shopA.client.rpc("shop_accept_work_order", { p_work_order: wo.id, p_pickup_window: null }));
    await must(
      shopA.client.rpc("shop_save_component", {
        p_work_order: wo.id, p_component: null, p_type: "DPF", p_manufacturer: "M", p_part_number: "P",
        p_serial_number: `SN-Q1-${runId}`, p_dp_before: 4, p_dp_after: 1, p_weight_before_g: 100,
        p_weight_after_g: 90, p_result: "cleaned", p_result_note: null,
      }),
    );
    await must(shopA.client.rpc("shop_add_part", { p_work_order: wo.id, p_catalog_item: f.part, p_qty: 2 }));
    await must(
      shopA.client.rpc("shop_request_authorization", { p_work_order: wo.id, p_catalog_item: f.service, p_qty: 1, p_note: "A asks" }),
    );
    await must(shopA.client.rpc("shop_decline_work_order", { p_work_order: wo.id, p_reason: "Cannot do it" }));
    await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: wo.id, p_affiliate: f.shopB }));

    expect(await must(shopB.client.from("work_order_components").select("id").eq("work_order_id", wo.id))).toEqual([]);
    expect(await must(shopB.client.from("authorization_requests").select("id").eq("work_order_id", wo.id))).toEqual([]);
    const lines = await must(shopB.client.from("work_order_lines").select("origin").eq("work_order_id", wo.id));
    expect(lines.map((l: { origin: string }) => l.origin)).toEqual(["cds_order"]);
    // CDS still has the record of what shop A entered.
    expect((await must(cds.client.from("work_order_components").select("id").eq("work_order_id", wo.id))).length).toBe(1);
  });

  it("BUG-4: dispatching after a default rate change keeps the rate the line was created with", async () => {
    const wo = await newWo(null, "pending_review", "Q1-4");
    await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.part, qty: 1 }));
    await must(cds.client.rpc("cds_set_price", { p_kind: "shop_rate", p_catalog_item: f.part, p_customer: null, p_amount: 10.5 }));
    try {
      await must(cds.client.rpc("cds_dispatch_work_order", { p_work_order: wo.id, p_affiliate: f.shopA }));
      const lines = await must(shopA.client.from("work_order_lines").select("shop_unit_rate").eq("work_order_id", wo.id));
      expect(lines.map((l: { shop_unit_rate: string }) => Number(l.shop_unit_rate))).toEqual([10]);
    } finally {
      await must(cds.client.rpc("cds_set_price", { p_kind: "shop_rate", p_catalog_item: f.part, p_customer: null, p_amount: 10 }));
    }
  });

  it("BUG-6: free text is limited in length", async () => {
    const { error } = await shopA.client.rpc("shop_decline_work_order", { p_work_order: f.woA, p_reason: "x".repeat(10_000) });
    expect(error?.message).toMatch(/too long/i);
    const row = await must(admin.from("work_orders").select("status").eq("id", f.woA).single());
    expect(row.status).toBe("awaiting_acceptance");
  });
});

describe("QA round 1 follow-up: files and requests after reassignment", () => {
  it("the new shop cannot download the previous shop's file, and its pending request is withdrawn", async () => {
    const wo = await insertOne("work_orders", {
      customer_id: f.customerX,
      location_label: `TEST-${runId}`,
      fulfillment: "shipping",
      affiliate_id: f.shopA,
      status: "accepted",
      unit_number: "Q1-F",
      requested_work: "Test cleaning",
    });
    await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
    await must(admin.from("work_order_lines").insert({ work_order_id: wo.id, catalog_item_id: f.service, qty: 1 }));
    const path = `${wo.id}/shop-a-photo.txt`;
    const { error: uploadError } = await admin.storage
      .from("wo-files")
      .upload(path, new Blob(["photo"], { type: "text/plain" }), { upsert: true });
    if (uploadError) throw uploadError;
    await must(
      admin.from("attachments").insert({ work_order_id: wo.id, category: "other", storage_path: path, file_name: "a.txt" }),
    );
    const req = await must(
      shopA.client.rpc("shop_request_authorization", { p_work_order: wo.id, p_catalog_item: f.service, p_qty: 1, p_note: "A asks" }),
    );
    expect((await shopA.client.storage.from("wo-files").download(path)).error).toBeNull();

    await must(cds.client.from("work_orders").update({ affiliate_id: f.shopB }).eq("id", wo.id));

    const download = await shopB.client.storage.from("wo-files").download(path);
    expect(download.error).not.toBeNull();
    expect(await must(shopB.client.from("attachments").select("id").eq("work_order_id", wo.id))).toEqual([]);
    const row = await must(cds.client.from("authorization_requests").select("status").eq("id", req).single());
    expect(row.status).toBe("withdrawn");
    expect((await must(cds.client.from("attachments").select("id").eq("work_order_id", wo.id))).length).toBe(1);
  });
});
