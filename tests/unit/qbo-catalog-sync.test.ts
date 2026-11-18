/**
 * Catalog sync from QuickBooks (CDS 2026-11-17: ENV-NOX-1632 was in QuickBooks but not in the
 * portal). The planning is pure: given the QuickBooks items and the portal catalog, links and
 * prices, it says what to create, link, rename and report. The run applies a plan through
 * injected writes; running twice creates nothing new. Nothing here calls QuickBooks or a
 * database.
 */
import { describe, expect, it } from "vitest";
import {
  catalogSyncStatus,
  inferCategory,
  looksLikePartNumber,
  newItemName,
  planCatalogSync,
  runCatalogSync,
  skuPrefixes,
  type CatalogSyncDeps,
  type CatalogSyncRunRecord,
  type PortalCatalogItem,
  type PortalLink,
  type QboCatalogItem,
} from "@/lib/qbo/catalog-sync";
import { QboError } from "@/lib/qbo/client";

const item = (over: Partial<PortalCatalogItem> & { id: string; sku: string }): PortalCatalogItem => ({
  category: "part",
  name: over.sku,
  tax_class: "parts",
  shop_selectable: true,
  pass_through: true,
  price_per_line: false,
  sellPrice: null,
  shopRate: null,
  ...over,
});

const qbo = (over: Partial<QboCatalogItem> & { Id: string; Name: string }): QboCatalogItem => ({
  Type: "NonInventory",
  Active: true,
  Taxable: true,
  ...over,
});

const link = (catalogItemId: string, qboItemId: string, qboItemName: string, customerId: string | null = null): PortalLink => ({
  catalogItemId,
  qboItemId,
  qboItemName,
  customerId,
});

const NOX_1619 = item({ id: "i-1619", sku: "ENV-NOX-1619", sellPrice: 259, shopRate: 0 });
const NOX_1614 = item({ id: "i-1614", sku: "ENV-NOX-1614", sellPrice: 259, shopRate: 189 });
const GASKET = item({ id: "i-g", sku: "CDS-G-1056", category: "gasket", name: "Cummins gasket", sellPrice: 12, shopRate: 6 });
const SVC = item({ id: "i-s", sku: "SVC-DPF", category: "service", name: "DPF Cleaning", tax_class: "labor", sellPrice: 300, shopRate: 150 });

const base = {
  catalog: [NOX_1619, NOX_1614, GASKET, SVC],
  links: [link("i-1619", "100", "ENV-NOX-1619"), link("i-1614", "101", "ENV-NOX-1614"), link("i-g", "200", "CDS-G-1056"), link("i-s", "300", "SVC-DPF")],
  reservedQboIds: [] as string[],
};
const linkedQbo = [
  qbo({ Id: "100", Name: "ENV-NOX-1619", UnitPrice: 259, PurchaseCost: 0 }),
  qbo({ Id: "101", Name: "ENV-NOX-1614", UnitPrice: 259, PurchaseCost: 189 }),
  qbo({ Id: "200", Name: "CDS-G-1056", UnitPrice: 12, PurchaseCost: 6 }),
  qbo({ Id: "300", Name: "SVC-DPF", Type: "Service", UnitPrice: 300, PurchaseCost: 150 }),
];

describe("planCatalogSync", () => {
  it("creates a missing QuickBooks part (ENV-NOX-1632) with its prices and the default link", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [...linkedQbo, qbo({ Id: "1632", Name: "ENV-NOX-1632", UnitPrice: 259, PurchaseCost: 189 })],
    });
    expect(plan.creates).toEqual([
      {
        sku: "ENV-NOX-1632",
        name: "ENV-NOX-1632",
        category: "part",
        tax_class: "parts",
        shop_selectable: true,
        pass_through: false,
        price_per_line: false,
        sell_price: 259,
        shop_rate: 189,
        qbo_item_id: "1632",
        qbo_item_name: "ENV-NOX-1632",
      },
    ]);
    expect(plan.links).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  it("links an existing portal item with the same SKU (trimmed, any case) that has no default link", () => {
    const plan = planCatalogSync({
      ...base,
      catalog: [...base.catalog, item({ id: "i-new", sku: "CDS-CL-DD05V", category: "clamp" })],
      qboItems: [...linkedQbo, qbo({ Id: "400", Name: "  cds-cl-dd05v ", UnitPrice: 40 })],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.links).toEqual([{ catalogItemId: "i-new", sku: "CDS-CL-DD05V", qboItemId: "400", qboItemName: "cds-cl-dd05v" }]);
  });

  it("matches on the QuickBooks Sku field before the name", () => {
    const plan = planCatalogSync({
      ...base,
      catalog: [...base.catalog, item({ id: "i-x", sku: "CDS-B-0001", category: "bung" })],
      qboItems: [...linkedQbo, qbo({ Id: "401", Name: "Bung 1 inch", Sku: "CDS-B-0001", UnitPrice: 9 })],
    });
    expect(plan.links).toEqual([{ catalogItemId: "i-x", sku: "CDS-B-0001", qboItemId: "401", qboItemName: "Bung 1 inch" }]);
    expect(plan.creates).toEqual([]);
  });

  it("links an item that has only customer links (no default link yet)", () => {
    const plan = planCatalogSync({
      ...base,
      catalog: [...base.catalog, item({ id: "i-am", sku: "CDS-G-1051" })],
      links: [...base.links, link("i-am", "777", "CDS-G-1051AM", "cust-fs")],
      qboItems: [...linkedQbo, qbo({ Id: "402", Name: "CDS-G-1051", UnitPrice: 10 }), qbo({ Id: "777", Name: "CDS-G-1051AM", UnitPrice: 11 })],
    });
    expect(plan.links).toEqual([{ catalogItemId: "i-am", sku: "CDS-G-1051", qboItemId: "402", qboItemName: "CDS-G-1051" }]);
    // 777 is linked as First Student's item: nothing to do for it.
    expect(plan.creates).toEqual([]);
  });

  it("does nothing for linked items whose name is unchanged", () => {
    const plan = planCatalogSync({ ...base, qboItems: linkedQbo });
    expect(plan).toMatchObject({ creates: [], links: [], renames: [], differences: [], skipped: [] });
    expect(plan.unchanged).toBe(4);
  });

  it("only updates the stored QuickBooks name of a renamed linked item, and reports a changed SKU", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [linkedQbo[0], linkedQbo[1], qbo({ Id: "200", Name: "CDS-G-1056-NEW", UnitPrice: 12, PurchaseCost: 6 }), linkedQbo[3]],
    });
    expect(plan.renames).toEqual([{ qboItemId: "200", from: "CDS-G-1056", to: "CDS-G-1056-NEW" }]);
    expect(plan.creates).toEqual([]);
    expect(plan.links).toEqual([]);
    expect(plan.differences).toEqual([{ sku: "CDS-G-1056", qboItemId: "200", field: "sku", portal: "CDS-G-1056", qbo: "CDS-G-1056-NEW" }]);
  });

  it("never changes portal names or prices of linked items: differences are only reported", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [linkedQbo[0], linkedQbo[1], qbo({ Id: "200", Name: "CDS-G-1056", UnitPrice: 14, PurchaseCost: 7 }), linkedQbo[3]],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.renames).toEqual([]);
    expect(plan.differences).toEqual([
      { sku: "CDS-G-1056", qboItemId: "200", field: "fleet_price", portal: 12, qbo: 14 },
      { sku: "CDS-G-1056", qboItemId: "200", field: "shop_rate", portal: 6, qbo: 7 },
    ]);
  });

  it("does not report a price difference when QuickBooks has no price", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [linkedQbo[0], linkedQbo[1], qbo({ Id: "200", Name: "CDS-G-1056" }), linkedQbo[3]],
    });
    expect(plan.differences).toEqual([]);
  });

  it("skips inactive items, categories and groups, vendor-only items without a sales price, and free-text names", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [
        ...linkedQbo,
        qbo({ Id: "500", Name: "ENV-NOX-1700", Active: false, UnitPrice: 259 }),
        qbo({ Id: "501", Name: "Sensors", Type: "Category" }),
        qbo({ Id: "502", Name: "CDS-KIT-ISZ-01", Type: "Group", UnitPrice: 99 }),
        qbo({ Id: "891", Name: "Shipping Credit", Type: "Service", PurchaseCost: 15 }),
        qbo({ Id: "503", Name: "CDS-G-9999", UnitPrice: 0, PurchaseCost: 3 }),
        qbo({ Id: "504", Name: "DPF Basic Clean (Ryder)", Type: "Service", UnitPrice: 250 }),
        qbo({ Id: "505", Name: "CDS-DPF-GESI0101 (First Student)", UnitPrice: 900 }),
      ],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.links).toEqual([]);
    expect(plan.skipped.map((s) => [s.qboItemId, s.reason])).toEqual([
      ["500", "inactive"],
      ["501", "type"],
      ["502", "type"],
      ["891", "no_price"],
      ["503", "no_price"],
      ["504", "not_a_part_number"],
      ["505", "not_a_part_number"],
    ]);
  });

  it("leaves QuickBooks items the portal already uses elsewhere alone (measurement items, the deduction item)", () => {
    const plan = planCatalogSync({
      ...base,
      reservedQboIds: ["891", "950"],
      qboItems: [...linkedQbo, qbo({ Id: "891", Name: "SHIP-CREDIT-01", UnitPrice: 15 }), qbo({ Id: "950", Name: "DPF-MEAS-RYDER", UnitPrice: 0 })],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.unchanged).toBe(6);
  });

  it("does not link a SKU whose portal item is already linked to another QuickBooks item", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [...linkedQbo, qbo({ Id: "600", Name: "CDS-G-1056", UnitPrice: 12 })],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.links).toEqual([]);
    expect(plan.skipped).toEqual([{ qboItemId: "600", name: "CDS-G-1056", reason: "sku_linked_elsewhere" }]);
  });

  it("creates one item when two QuickBooks items share a SKU, and reports the second", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [...linkedQbo, qbo({ Id: "700", Name: "ENV-NOX-1640", UnitPrice: 259 }), qbo({ Id: "701", Name: "env-nox-1640", UnitPrice: 260 })],
    });
    expect(plan.creates.map((c) => c.qbo_item_id)).toEqual(["700"]);
    expect(plan.skipped).toEqual([{ qboItemId: "701", name: "env-nox-1640", reason: "duplicate_sku" }]);
  });

  it("maps prices: UnitPrice is the Fleet Price, PurchaseCost the default Shop Rate; 0 or missing is left empty", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [
        qbo({ Id: "800", Name: "ENV-NOX-1650", UnitPrice: 259.5, PurchaseCost: 0 }),
        qbo({ Id: "801", Name: "ENV-NOX-1651", UnitPrice: 259 }),
        qbo({ Id: "802", Name: "ENV-NOX-1652", UnitPrice: 100.456, PurchaseCost: 50.004 }),
      ],
    });
    expect(plan.creates.map((c) => [c.sku, c.sell_price, c.shop_rate])).toEqual([
      ["ENV-NOX-1650", 259.5, null],
      ["ENV-NOX-1651", 259, null],
      ["ENV-NOX-1652", 100.46, 50],
    ]);
  });

  it("names a new item after its QuickBooks sales description (first line), else its name; the SKU is upper case", () => {
    const plan = planCatalogSync({
      ...base,
      qboItems: [
        qbo({ Id: "900", Name: "cds-g-17451", Description: "  Cummins ISX  gasket\nP/N: 123 ", UnitPrice: 20 }),
        qbo({ Id: "901", Name: "ENV-NOX-1660", Description: "   ", UnitPrice: 20 }),
      ],
    });
    expect(plan.creates.map((c) => [c.sku, c.name])).toEqual([
      ["CDS-G-17451", "Cummins ISX gasket"],
      ["ENV-NOX-1660", "ENV-NOX-1660"],
    ]);
  });

  it("takes category, tax class and flags from existing items with the same SKU prefix", () => {
    const catalog = [
      ...base.catalog,
      item({ id: "c1", sku: "CDS-CL-DD01", category: "clamp", shop_selectable: false, pass_through: true }),
      item({ id: "c2", sku: "CDS-CL-DD02", category: "clamp", shop_selectable: false }),
      item({ id: "c3", sku: "CDS-CL-DD03", category: "part", shop_selectable: true }),
      item({ id: "s1", sku: "SVC-EGR", category: "service", tax_class: "labor" }),
      item({ id: "s2", sku: "SVC-SHIP", category: "service", tax_class: "shipping" }),
    ];
    const plan = planCatalogSync({
      ...base,
      catalog,
      qboItems: [
        qbo({ Id: "1", Name: "CDS-CL-DD09", UnitPrice: 30 }),
        qbo({ Id: "2", Name: "SVC-SCR", Type: "Service", UnitPrice: 200 }),
        qbo({ Id: "3", Name: "NAES-G-CU", UnitPrice: 5 }),
        qbo({ Id: "4", Name: "LAB-HOUR", Type: "Service", UnitPrice: 95 }),
        qbo({ Id: "5", Name: "CDS-G-2000", UnitPrice: 8, Taxable: false }),
      ],
    });
    expect(plan.creates.map((c) => [c.sku, c.category, c.tax_class, c.shop_selectable])).toEqual([
      ["CDS-CL-DD09", "clamp", "parts", false],
      ["SVC-SCR", "service", "labor", true],
      ["NAES-G-CU", "part", "parts", true],
      ["LAB-HOUR", "service", "labor", true],
      ["CDS-G-2000", "gasket", "exempt", true],
    ]);
  });

  it("creates a plain item (not priced per line, not pass through), whatever its category's items are", () => {
    // RECON DECOMP (2026-11-18) came in as pass through because most parts carry the column
    // default; a category of per-line items must not turn a new item into one either.
    const catalog = [
      ...base.catalog,
      item({ id: "m1", sku: "CDS-CL-X1", category: "clamp", pass_through: true, price_per_line: true }),
      item({ id: "m2", sku: "CDS-CL-X2", category: "clamp", pass_through: true, price_per_line: true }),
      item({ id: "r1", sku: "CDS-DECOMP-RECON0", category: "part", pass_through: false, price_per_line: true }),
    ];
    const plan = planCatalogSync({
      ...base,
      catalog,
      qboItems: [qbo({ Id: "1", Name: "CDS-CL-X3", UnitPrice: 30 }), qbo({ Id: "2", Name: "CDS-DECOMP-RECON1", UnitPrice: 500 })],
    });
    expect(plan.creates.map((c) => [c.sku, c.category, c.pass_through, c.price_per_line])).toEqual([
      ["CDS-CL-X3", "clamp", false, false],
      ["CDS-DECOMP-RECON1", "part", false, false],
    ]);
  });

  it("is idempotent: once the plan is applied, planning again creates and links nothing", () => {
    const input = {
      ...base,
      catalog: [...base.catalog, item({ id: "i-new", sku: "CDS-CL-DD05V", category: "clamp", sellPrice: 40 })],
      qboItems: [...linkedQbo, qbo({ Id: "400", Name: "CDS-CL-DD05V", UnitPrice: 40 }), qbo({ Id: "1632", Name: "ENV-NOX-1632", UnitPrice: 259, PurchaseCost: 189 })],
    };
    const first = planCatalogSync(input);
    expect(first.creates).toHaveLength(1);
    expect(first.links).toHaveLength(1);
    const after = {
      ...input,
      catalog: [...input.catalog, item({ id: "i-1632", sku: "ENV-NOX-1632", sellPrice: 259, shopRate: 189 })],
      links: [...input.links, link("i-new", "400", "CDS-CL-DD05V"), link("i-1632", "1632", "ENV-NOX-1632")],
    };
    const second = planCatalogSync(after);
    expect(second).toMatchObject({ creates: [], links: [], renames: [], differences: [], skipped: [] });
  });
});

describe("helpers", () => {
  it("looksLikePartNumber: dash-separated codes without spaces", () => {
    for (const ok of ["ENV-NOX-1632", "CDS-G-17451", "SVC-DPF", "CDS-CL-DD05V", "CDS-G-1.5", "CDS-DOC-GESi557"]) expect(looksLikePartNumber(ok), ok).toBe(true);
    for (const no of ["Shipping Credit", "DPF Basic Clean (Ryder)", "CU 4376837", "LABOR", "CDS-CL-1058(pending name change)", "-X", "A-", ""]) {
      expect(looksLikePartNumber(no), no).toBe(false);
    }
  });

  it("skuPrefixes: longest first, never the whole SKU", () => {
    expect(skuPrefixes("CDS-KIT-ISZ-01")).toEqual(["CDS-KIT-ISZ", "CDS-KIT", "CDS"]);
    expect(skuPrefixes("SVC-DPF")).toEqual(["SVC"]);
  });

  it("inferCategory: the most common category of the longest prefix that has items", () => {
    const catalog = [item({ id: "a", sku: "CDS-G-1", category: "gasket" }), item({ id: "b", sku: "CDS-G-2", category: "gasket" }), item({ id: "c", sku: "CDS-B-1", category: "bung" })];
    expect(inferCategory("CDS-G-3", "NonInventory", catalog)).toBe("gasket");
    expect(inferCategory("CDS-Z-3", "NonInventory", catalog)).toBe("gasket");
    expect(inferCategory("XYZ-1", "NonInventory", catalog)).toBe("part");
    expect(inferCategory("XYZ-1", "Service", catalog)).toBe("service");
  });

  it("newItemName caps the name at 200 characters", () => {
    expect(newItemName({ Id: "1", Name: "X-1", Description: "a".repeat(300) })).toHaveLength(200);
  });
});

describe("runCatalogSync", () => {
  function memoryDeps(qboItems: QboCatalogItem[] | (() => Promise<QboCatalogItem[]>)) {
    const state = {
      catalog: [...base.catalog],
      links: [...base.links],
      runs: [] as CatalogSyncRunRecord[],
      created: [] as string[],
    };
    const deps: CatalogSyncDeps = {
      listQboItems: typeof qboItems === "function" ? qboItems : async () => qboItems,
      loadPortal: async () => ({ catalog: [...state.catalog], links: [...state.links], reservedQboIds: ["891"] }),
      createItem: async (c) => {
        if (state.catalog.some((i) => i.sku === c.sku)) return { id: "dup", created: false };
        const id = `new-${c.sku}`;
        state.catalog.push(item({ id, sku: c.sku, category: c.category, sellPrice: c.sell_price, shopRate: c.shop_rate }));
        state.links.push(link(id, c.qbo_item_id, c.qbo_item_name));
        state.created.push(c.sku);
        return { id, created: true };
      },
      link: async (l) => {
        if (state.links.some((x) => x.catalogItemId === l.catalogItemId && x.customerId === null)) return false;
        state.links.push(link(l.catalogItemId, l.qboItemId, l.qboItemName));
        return true;
      },
      rename: async (r) => {
        for (const x of state.links) if (x.qboItemId === r.qboItemId) x.qboItemName = r.to;
      },
      recordRun: async (run) => {
        state.runs.push(run);
      },
      now: () => new Date("2026-11-17T20:00:00Z"),
    };
    return { state, deps };
  }

  const qboNow = [...linkedQbo, qbo({ Id: "1632", Name: "ENV-NOX-1632", UnitPrice: 259, PurchaseCost: 189 }), qbo({ Id: "891", Name: "Shipping Credit", Type: "Service" })];

  it("applies the plan, records the run, and a second run creates nothing new", async () => {
    const { state, deps } = memoryDeps(qboNow);
    const first = await runCatalogSync(deps, "cron");
    expect(first).toMatchObject({ status: "ok", created: 1, linked: 0, renamed: 0 });
    expect(state.created).toEqual(["ENV-NOX-1632"]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ trigger: "cron", status: "ok", qbo_items: 6, created: 1, linked: 0, error: null });
    expect(state.runs[0].details.created).toEqual([{ sku: "ENV-NOX-1632", qbo_item_id: "1632" }]);

    const second = await runCatalogSync(deps, "cron");
    expect(second).toMatchObject({ status: "ok", created: 0, linked: 0, renamed: 0 });
    expect(state.created).toEqual(["ENV-NOX-1632"]);
    expect(state.runs).toHaveLength(2);
  });

  it("a dry run returns the plan and writes nothing", async () => {
    const { state, deps } = memoryDeps(qboNow);
    const r = await runCatalogSync(deps, "cron", { dryRun: true });
    expect(r).toMatchObject({ status: "dry_run", created: 1, linked: 0 });
    expect(r.status === "dry_run" && r.plan.creates.map((c) => c.sku)).toEqual(["ENV-NOX-1632"]);
    expect(state.created).toEqual([]);
    expect(state.runs).toEqual([]);
  });

  it("skips cleanly (nothing recorded) when QuickBooks is not connected", async () => {
    const { state, deps } = memoryDeps(async () => {
      throw new QboError("QuickBooks is not connected. Connect it in Admin > Settings.", 0, "Config");
    });
    const r = await runCatalogSync(deps, "cron");
    expect(r).toEqual({ status: "skipped", reason: "QuickBooks is not connected. Connect it in Admin > Settings." });
    expect(state.runs).toEqual([]);
  });

  it("records a failed run when QuickBooks cannot be read", async () => {
    const { state, deps } = memoryDeps(async () => {
      throw new QboError("The QuickBooks connection has expired or was revoked.", 401, "OAuth");
    });
    const r = await runCatalogSync(deps, "manual");
    expect(r).toMatchObject({ status: "failed", error: "The QuickBooks connection has expired or was revoked." });
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ trigger: "manual", status: "failed", created: 0, error: "The QuickBooks connection has expired or was revoked." });
  });

  it("keeps going when one item fails and records the error", async () => {
    const { state, deps } = memoryDeps([...qboNow, qbo({ Id: "1633", Name: "ENV-NOX-1633", UnitPrice: 259 })]);
    const createItem = deps.createItem;
    deps.createItem = async (c) => {
      if (c.sku === "ENV-NOX-1632") throw new Error("boom");
      return createItem(c);
    };
    const r = await runCatalogSync(deps, "cron");
    expect(r).toMatchObject({ status: "failed", created: 1 });
    expect(state.created).toEqual(["ENV-NOX-1633"]);
    expect(state.runs[0].error).toBe("ENV-NOX-1632: boom");
  });
});

describe("catalogSyncStatus", () => {
  const run = (over: Partial<CatalogSyncRunRecord & { finished_at: string }> = {}) => ({
    finished_at: "2026-11-17T20:00:00Z",
    status: "ok",
    created: 0,
    linked: 0,
    error: null,
    details: { created: [] },
    ...over,
  });

  it("says never when there is no run", () => {
    expect(catalogSyncStatus([])).toEqual({ text: "Not synced from QuickBooks yet.", error: null });
  });

  it("shows the last successful run with its new items", () => {
    expect(catalogSyncStatus([run({ created: 2, details: { created: [{ sku: "ENV-NOX-1632", qbo_item_id: "1" }, { sku: "ENV-NOX-1633", qbo_item_id: "2" }] } })])).toEqual({
      text: "Last synced from QuickBooks: 2026-11-17 12:00 PT, 2 new items (ENV-NOX-1632, ENV-NOX-1633).",
      error: null,
    });
    expect(catalogSyncStatus([run({ linked: 1 })]).text).toBe("Last synced from QuickBooks: 2026-11-17 12:00 PT, no new items, 1 linked by SKU.");
    expect(catalogSyncStatus([run({ created: 1, details: { created: [{ sku: "A-1", qbo_item_id: "1" }] } })]).text).toBe(
      "Last synced from QuickBooks: 2026-11-17 12:00 PT, 1 new item (A-1).",
    );
  });

  it("shows the error of the latest run when it failed", () => {
    expect(
      catalogSyncStatus([run({ status: "failed", error: "QuickBooks could not be reached", finished_at: "2026-11-17T21:00:00Z" }), run()]),
    ).toEqual({
      text: "Last synced from QuickBooks: 2026-11-17 12:00 PT, no new items.",
      error: "The last QuickBooks sync failed (2026-11-17 13:00 PT): QuickBooks could not be reached",
    });
  });
});
