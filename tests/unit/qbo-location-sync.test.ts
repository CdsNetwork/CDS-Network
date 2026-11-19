/**
 * QuickBooks customers (sites) become portal locations automatically (CDS 2026-11-19). The
 * planning is pure: given the active QuickBooks customers, the portal customers linked on
 * Admin > QuickBooks mappings and their locations, it says which locations to link and which
 * to create. The run applies the plan through injected writes; running twice creates nothing
 * new. Nothing here calls QuickBooks or a database. Company and site names are made up.
 */
import { describe, expect, it } from "vitest";
import { QboError } from "@/lib/qbo/client";
import {
  locationCode,
  locationSyncEnabled,
  locationSyncStatus,
  planLocationSync,
  runLocationSync,
  siteAddress,
  siteRelation,
  type LinkedPortalCustomer,
  type LocationSyncDeps,
  type LocationSyncRunRecord,
  type PortalLocationRow,
  type QboSiteRecord,
} from "@/lib/qbo/location-sync";

// Portal customers and the QuickBooks customers they are linked to.
const ACME = "cust-acme";
const BOLT = "cust-bolt";
const linked: LinkedPortalCustomer[] = [
  { customerId: ACME, qboCustomerId: "10" },
  { customerId: BOLT, qboCustomerId: "20" },
];

const acmeParent: QboSiteRecord = { Id: "10", DisplayName: "Acme Fleet", FullyQualifiedName: "Acme Fleet", Active: true };
const boltParent: QboSiteRecord = { Id: "20", DisplayName: "Bolt Haul", FullyQualifiedName: "Bolt Haul", Active: true };

const sub = (id: string, name: string, over: Partial<QboSiteRecord> = {}): QboSiteRecord => ({
  Id: id,
  DisplayName: name,
  FullyQualifiedName: `Acme Fleet:${name}`,
  Job: true,
  Active: true,
  ParentRef: { value: "10" },
  ...over,
});
const top = (id: string, name: string, over: Partial<QboSiteRecord> = {}): QboSiteRecord => ({
  Id: id,
  DisplayName: name,
  FullyQualifiedName: name,
  Active: true,
  ...over,
});

const loc = (over: Partial<PortalLocationRow> & { id: string; code: string }): PortalLocationRow => ({
  customerId: ACME,
  locationNumber: null,
  name: over.code,
  city: null,
  qboCustomerId: null,
  ...over,
});

describe("siteRelation", () => {
  it("finds sub-customers at any depth by FullyQualifiedName", () => {
    expect(siteRelation(sub("11", "ACME - 297-PINE RIDGE CO"), acmeParent)).toEqual({ kind: "sub", ownName: "ACME - 297-PINE RIDGE CO" });
    const deep = sub("12", "512-LAKEVIEW", { FullyQualifiedName: "Acme Fleet:West:512-LAKEVIEW", ParentRef: { value: "99" } });
    expect(siteRelation(deep, acmeParent)).toEqual({ kind: "sub", ownName: "512-LAKEVIEW" });
  });

  it("finds top-level customers named after the parent with a separator", () => {
    const parent = top("30", "Torq by Acme");
    expect(siteRelation(top("31", "Torq by Acme - 1885 Dallas"), parent)).toEqual({ kind: "prefix", ownName: "1885 Dallas" });
    expect(siteRelation(top("32", "Torq by Acme -Tampa"), parent)).toEqual({ kind: "prefix", ownName: "Tampa" });
    expect(siteRelation(top("33", "Torq by Acme-Reno"), parent)).toEqual({ kind: "prefix", ownName: "Reno" });
    expect(siteRelation(top("34", "Torq by Acme Boise"), parent)).toEqual({ kind: "prefix", ownName: "Boise" });
    expect(siteRelation(top("35", "torq by acme - Mesa"), parent)).toEqual({ kind: "prefix", ownName: "Mesa" });
  });

  it("is null for the parent itself, other names and names that only start with the same letters", () => {
    const parent = top("30", "Torq by Acme");
    expect(siteRelation(parent, parent)).toBeNull();
    expect(siteRelation(top("36", "Torq by Acmeville"), parent)).toBeNull();
    expect(siteRelation(top("37", "Torq by Acme - "), parent)).toBeNull();
    expect(siteRelation(top("38", "Other Fleet - Tampa"), parent)).toBeNull();
    // A sub-customer of another parent is not a top-level name match.
    expect(siteRelation(sub("39", "Torq by Acme - X", { FullyQualifiedName: "Other:Torq by Acme - X", ParentRef: { value: "77" } }), parent)).toBeNull();
  });
});

describe("locationCode", () => {
  it("is the site number and the city, like the routing codes (424-PITTSBURGH)", () => {
    expect(locationCode({ site: "297", city: "Pine Ridge", ownName: "ACME - 297-PINE RIDGE CO", qboId: "11" })).toBe("297-PINE RIDGE");
  });
  it("uses the name after the site number when there is no city", () => {
    expect(locationCode({ site: "297", city: null, ownName: "ACME - 297-PINE RIDGE CO", qboId: "11" })).toBe("297-PINE RIDGE CO");
    expect(locationCode({ site: "1885", city: null, ownName: "1885 Dallas", qboId: "31" })).toBe("1885-DALLAS");
    expect(locationCode({ site: "44", city: null, ownName: "44", qboId: "31" })).toBe("44");
  });
  it("is the city or name without a site number, else the QuickBooks id", () => {
    expect(locationCode({ site: null, city: "Tampa", ownName: "Tampa yard", qboId: "32" })).toBe("TAMPA");
    expect(locationCode({ site: null, city: null, ownName: "Tampa yard", qboId: "32" })).toBe("TAMPA YARD");
    expect(locationCode({ site: null, city: null, ownName: "###", qboId: "32" })).toBe("QB-32");
  });
});

describe("siteAddress", () => {
  it("takes ShipAddr, else BillAddr, with a one-line address", () => {
    const c = sub("11", "X", {
      ShipAddr: { Line1: "15 Mill Rd", City: "Pine Ridge", CountrySubDivisionCode: "co", PostalCode: "80901", Country: "USA" },
      BillAddr: { Line1: "PO Box 1", City: "Elsewhere" },
    });
    expect(siteAddress(c)).toEqual({
      address_raw: "15 Mill Rd, Pine Ridge, CO 80901",
      address_line1: "15 Mill Rd",
      city: "Pine Ridge",
      region: "CO",
      postal_code: "80901",
      country: "US",
      market: "US",
    });
    expect(siteAddress(sub("11", "X", { BillAddr: { Line1: "PO Box 1", City: "Elsewhere" } })).city).toBe("Elsewhere");
  });
  it("is empty without an address; Canada is market CA", () => {
    expect(siteAddress(sub("11", "X"))).toEqual({
      address_raw: "",
      address_line1: null,
      city: null,
      region: null,
      postal_code: null,
      country: "US",
      market: "US",
    });
    expect(siteAddress(sub("11", "X", { ShipAddr: { City: "Hamilton", CountrySubDivisionCode: "ON", Country: "Canada" } }))).toMatchObject({ country: "CA", market: "CA" });
  });
});

describe("planLocationSync", () => {
  const sites = [
    acmeParent,
    boltParent,
    sub("11", "ACME - 297-PINE RIDGE CO", { ShipAddr: { Line1: "15 Mill Rd", City: "Pine Ridge", CountrySubDivisionCode: "CO", PostalCode: "80901" } }),
    sub("12", "ACME - 0412-OAK FALLS"),
    sub("13", "ACME - 530-HARBOR"),
  ];

  it("first run: links a location with the same site number, creates the others (all sites, not only new ones)", () => {
    const plan = planLocationSync({
      qboCustomers: sites,
      customers: linked,
      locations: [loc({ id: "l-412", code: "412-OAK FALLS", locationNumber: "412" }), loc({ id: "l-x", code: "999-ELSEWHERE", locationNumber: "999" })],
    });
    expect(plan.links).toEqual([{ locationId: "l-412", customerId: ACME, code: "412-OAK FALLS", qboCustomerId: "12", qboCustomerName: "Acme Fleet:ACME - 0412-OAK FALLS" }]);
    expect(plan.creates).toEqual([
      {
        customer_id: ACME,
        code: "297-PINE RIDGE",
        location_number: "297",
        name: "ACME - 297-PINE RIDGE CO",
        address_raw: "15 Mill Rd, Pine Ridge, CO 80901",
        address_line1: "15 Mill Rd",
        city: "Pine Ridge",
        region: "CO",
        postal_code: "80901",
        country: "US",
        market: "US",
        qbo_customer_id: "11",
        qbo_customer_name: "Acme Fleet:ACME - 297-PINE RIDGE CO",
      },
      expect.objectContaining({ customer_id: ACME, code: "530-HARBOR", location_number: "530", name: "ACME - 530-HARBOR", qbo_customer_id: "13" }),
    ]);
  });

  it("skips sites already linked to a location of that customer, and running on the result plans nothing", () => {
    const plan = planLocationSync({
      qboCustomers: sites,
      customers: linked,
      locations: [
        loc({ id: "a", code: "297-PINE RIDGE", locationNumber: "297", qboCustomerId: "11" }),
        loc({ id: "b", code: "412-OAK FALLS", locationNumber: "412", qboCustomerId: "12" }),
        loc({ id: "c", code: "530-HARBOR", locationNumber: "530", qboCustomerId: "13" }),
      ],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.links).toEqual([]);
    expect(plan.unchanged).toBe(3);
  });

  it("matches the site number from the location code when it has no location number, never one already linked", () => {
    const plan = planLocationSync({
      qboCustomers: [acmeParent, sub("12", "ACME - 0412-OAK FALLS")],
      customers: linked,
      locations: [loc({ id: "l-412", code: "412-OAK FALLS" })],
    });
    expect(plan.links.map((l) => l.locationId)).toEqual(["l-412"]);

    const taken = planLocationSync({
      qboCustomers: [acmeParent, sub("12", "ACME - 0412-OAK FALLS")],
      customers: linked,
      locations: [loc({ id: "l-412", code: "412-OAK FALLS", qboCustomerId: "88" })],
    });
    expect(taken.links).toEqual([]);
    // The code is unique per customer: a suffix when the routing code is taken.
    expect(taken.creates.map((c) => c.code)).toEqual(["412-OAK FALLS-2"]);
  });

  it("two QuickBooks sites with one site number (two 1083s) and one portal location: the name decides, the other is created", () => {
    const plan = planLocationSync({
      qboCustomers: [acmeParent, sub("21", "ACME - 1083-RIVERBEND BOTTLING"), sub("22", "Acme - 1083-YOUNGTON")],
      customers: linked,
      locations: [loc({ id: "l-1083", code: "1083-YOUNGTON", locationNumber: "1083", name: "Youngton", city: "Youngton" })],
    });
    expect(plan.links.map((l) => [l.locationId, l.qboCustomerId])).toEqual([["l-1083", "22"]]);
    expect(plan.creates.map((c) => [c.qbo_customer_id, c.code])).toEqual([["21", "1083-RIVERBEND BOTTLING"]]);
  });

  it("several portal locations with the site number: the name decides, else a new location", () => {
    const locations = [
      loc({ id: "l-a", code: "1083-A", locationNumber: "1083", name: "Riverbend" }),
      loc({ id: "l-b", code: "1083-B", locationNumber: "1083", name: "Youngton" }),
    ];
    const byName = planLocationSync({ qboCustomers: [acmeParent, sub("22", "Acme - 1083-YOUNGTON")], customers: linked, locations });
    expect(byName.links.map((l) => l.locationId)).toEqual(["l-b"]);
    const unclear = planLocationSync({ qboCustomers: [acmeParent, sub("23", "Acme - 1083-CENTRAL")], customers: linked, locations });
    expect(unclear.links).toEqual([]);
    expect(unclear.creates.map((c) => c.qbo_customer_id)).toEqual(["23"]);
  });

  it("top-level customers named after the parent are sites of that customer (Torq by Acme - 1885 Dallas)", () => {
    const torq = top("30", "Torq by Acme");
    const plan = planLocationSync({
      qboCustomers: [torq, top("31", "Torq by Acme - 1885 Dallas", { BillAddr: { City: "Dallas", CountrySubDivisionCode: "TX" } }), top("32", "Torq by Acme - Tampa")],
      customers: [{ customerId: "cust-torq", qboCustomerId: "30" }],
      locations: [],
    });
    expect(plan.creates.map((c) => [c.customer_id, c.code, c.location_number, c.name, c.qbo_customer_name])).toEqual([
      ["cust-torq", "1885-DALLAS", "1885", "1885 Dallas", "Torq by Acme - 1885 Dallas"],
      ["cust-torq", "TAMPA", null, "Tampa", "Torq by Acme - Tampa"],
    ]);
  });

  it("skips inactive customers, the linked customers themselves and other companies", () => {
    const plan = planLocationSync({
      qboCustomers: [acmeParent, boltParent, sub("14", "ACME - 77-CLOSED", { Active: false }), top("50", "Unrelated Trucking")],
      customers: linked,
      locations: [],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.links).toEqual([]);
  });

  it("a site goes to the closest linked parent; a QuickBooks customer linked to its own portal customer is never a site", () => {
    const west: QboSiteRecord = sub("40", "West", { FullyQualifiedName: "Acme Fleet:West" });
    const plan = planLocationSync({
      qboCustomers: [acmeParent, west, sub("41", "88-DUNE", { FullyQualifiedName: "Acme Fleet:West:88-DUNE", ParentRef: { value: "40" } })],
      customers: [...linked, { customerId: "cust-west", qboCustomerId: "40" }],
      locations: [],
    });
    expect(plan.creates.map((c) => [c.customer_id, c.qbo_customer_id])).toEqual([["cust-west", "41"]]);
  });

  it("reports a portal customer whose QuickBooks customer is missing or inactive", () => {
    const plan = planLocationSync({ qboCustomers: [acmeParent], customers: [...linked, { customerId: "cust-gone", qboCustomerId: "404" }], locations: [] });
    expect(plan.skipped).toEqual([
      { qboCustomerId: "20", name: "cust-bolt", reason: "parent_not_found" },
      { qboCustomerId: "404", name: "cust-gone", reason: "parent_not_found" },
    ]);
  });

  it("a site linked to two portal customers at the same distance is reported, not created twice", () => {
    const plan = planLocationSync({
      qboCustomers: [acmeParent, sub("11", "ACME - 297-PINE RIDGE CO")],
      customers: [{ customerId: ACME, qboCustomerId: "10" }, { customerId: "cust-twin", qboCustomerId: "10" }],
      locations: [],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.skipped).toEqual([{ qboCustomerId: "11", name: "Acme Fleet:ACME - 297-PINE RIDGE CO", reason: "several_portal_customers" }]);
  });
});

describe("runLocationSync", () => {
  function memoryDeps(qboCustomers: QboSiteRecord[] | (() => Promise<QboSiteRecord[]>), locations: PortalLocationRow[] = []) {
    const state = { locations: [...locations], runs: [] as LocationSyncRunRecord[], enabled: true };
    const deps: LocationSyncDeps = {
      enabled: async () => state.enabled,
      listQboCustomers: typeof qboCustomers === "function" ? qboCustomers : async () => qboCustomers,
      loadPortal: async () => ({ customers: linked, locations: state.locations.map((l) => ({ ...l })) }),
      createLocation: async (c) => {
        const existing = state.locations.find((l) => l.customerId === c.customer_id && l.qboCustomerId === c.qbo_customer_id);
        if (existing) return { id: existing.id, created: false };
        const id = `new-${c.qbo_customer_id}`;
        state.locations.push(loc({ id, customerId: c.customer_id, code: c.code, locationNumber: c.location_number, qboCustomerId: c.qbo_customer_id }));
        return { id, created: true };
      },
      link: async (l) => {
        const row = state.locations.find((x) => x.id === l.locationId);
        if (!row || row.qboCustomerId) return false;
        row.qboCustomerId = l.qboCustomerId;
        return true;
      },
      recordRun: async (run) => {
        state.runs.push(run);
      },
      now: () => new Date("2026-11-19T18:00:00Z"),
    };
    return { deps, state };
  }
  const qboSites = [acmeParent, boltParent, sub("11", "ACME - 297-PINE RIDGE CO"), sub("12", "ACME - 412-OAK FALLS")];

  it("creates and links, records the run, and a second run changes nothing", async () => {
    const { deps, state } = memoryDeps(qboSites, [loc({ id: "l-412", code: "412-OAK FALLS", locationNumber: "412" })]);
    expect(await runLocationSync(deps, "cron")).toEqual({ status: "ok", created: 1, linked: 1, skipped: 0 });
    expect(state.runs[0]).toMatchObject({ trigger: "cron", status: "ok", qbo_customers: 4, created: 1, linked: 1, error: null });
    expect(state.runs[0].details.created).toEqual([{ code: "297-PINE RIDGE CO", qbo_customer_id: "11" }]);
    expect(await runLocationSync(deps, "manual")).toEqual({ status: "ok", created: 0, linked: 0, skipped: 0 });
    expect(state.locations).toHaveLength(2);
  });

  it("a concurrent run that created the site first counts nothing (created false)", async () => {
    const { deps, state } = memoryDeps(qboSites);
    const plain = deps.createLocation;
    deps.createLocation = async (c) => {
      await plain(c);
      return { id: "x", created: false };
    };
    expect(await runLocationSync(deps, "cron")).toMatchObject({ status: "ok", created: 0 });
    expect(state.locations).toHaveLength(2);
  });

  it("while the sync is off (the default) a real run does nothing: no QuickBooks call, no write, no run record", async () => {
    let called = false;
    const { deps, state } = memoryDeps(async () => {
      called = true;
      return qboSites;
    });
    state.enabled = false;
    expect(await runLocationSync(deps, "cron")).toEqual({ status: "skipped", reason: "location sync is off" });
    expect(await runLocationSync(deps, "manual")).toEqual({ status: "skipped", reason: "location sync is off" });
    expect(called).toBe(false);
    expect(state.locations).toEqual([]);
    expect(state.runs).toEqual([]);
  });

  it("while the sync is off a dry run still returns the plan", async () => {
    const { deps, state } = memoryDeps(qboSites);
    state.enabled = false;
    expect(await runLocationSync(deps, "cron", { dryRun: true })).toMatchObject({ status: "dry_run", created: 2, linked: 0 });
    expect(state.locations).toEqual([]);
  });

  it("dry run: returns the plan and writes nothing", async () => {
    const { deps, state } = memoryDeps(qboSites);
    const r = await runLocationSync(deps, "manual", { dryRun: true });
    expect(r).toMatchObject({ status: "dry_run", created: 2, linked: 0 });
    expect(state.locations).toEqual([]);
    expect(state.runs).toEqual([]);
  });

  it("not connected: skipped, nothing recorded; a QuickBooks failure is recorded as failed", async () => {
    const off = memoryDeps(async () => {
      throw new QboError("QuickBooks is not connected.", 0, "Config");
    });
    expect(await runLocationSync(off.deps, "cron")).toEqual({ status: "skipped", reason: "QuickBooks is not connected." });
    expect(off.state.runs).toEqual([]);

    const down = memoryDeps(async () => {
      throw new Error("QuickBooks could not be reached");
    });
    expect(await runLocationSync(down.deps, "cron")).toMatchObject({ status: "failed", error: "QuickBooks could not be reached" });
    expect(down.state.runs[0]).toMatchObject({ status: "failed", error: "QuickBooks could not be reached" });
  });

  it("one failing write does not stop the others; the run is failed with the error", async () => {
    const { deps, state } = memoryDeps(qboSites);
    const plain = deps.createLocation;
    deps.createLocation = async (c) => {
      if (c.qbo_customer_id === "11") throw new Error("boom");
      return plain(c);
    };
    expect(await runLocationSync(deps, "cron")).toMatchObject({ status: "failed", created: 1, error: "297-PINE RIDGE CO: boom" });
    expect(state.runs[0].status).toBe("failed");
  });
});

describe("locationSyncEnabled", () => {
  it("is on only for the setting {\"enabled\": true}; missing or anything else is off", () => {
    expect(locationSyncEnabled({ enabled: true })).toBe(true);
    for (const v of [undefined, null, {}, { enabled: false }, { enabled: "true" }, true, "on"]) expect(locationSyncEnabled(v)).toBe(false);
  });
});

describe("locationSyncStatus", () => {
  it("shows the last successful run with its counts, and the latest error", () => {
    expect(locationSyncStatus([])).toEqual({ text: "Not synced from QuickBooks yet.", error: null });
    const s = locationSyncStatus([
      { finished_at: "2026-11-19T19:00:00Z", status: "failed", created: 0, linked: 0, error: "boom" },
      { finished_at: "2026-11-19T18:00:00Z", status: "ok", created: 3, linked: 2, error: null },
    ]);
    expect(s.text).toBe("Last synced from QuickBooks: 2026-11-19 10:00 PT, 3 new locations, 2 linked.");
    expect(s.error).toBe("The last QuickBooks sync failed (2026-11-19 11:00 PT): boom");
    expect(locationSyncStatus([{ finished_at: "2026-11-19T18:00:00Z", status: "ok", created: 1, linked: 0, error: null }]).text).toBe(
      "Last synced from QuickBooks: 2026-11-19 10:00 PT, 1 new location, 0 linked.",
    );
  });
});
