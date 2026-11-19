/**
 * Location sync from QuickBooks (CDS 2026-11-19: "bring in all sites"). CDS keeps a fleet's
 * sites in QuickBooks either as sub-customers of the parent ("Acme:ACME - 297-PINE RIDGE CO",
 * at any depth) or as top-level customers named after it ("Torq by Acme - Tampa" while the
 * parent is "Torq by Acme"). Every hour (and on "Sync now" on Admin > Locations) the portal
 * reads the active QuickBooks customers and, for every active portal customer linked to a
 * QuickBooks customer (Admin > QuickBooks mappings), handles each site:
 *
 *   a. A location of that portal customer already has this QuickBooks customer: nothing.
 *   b. Else exactly one location of that customer has the same site number (siteNumberOf the
 *      site's own name vs locationSiteNumber(location_number, code)) and no QuickBooks
 *      customer yet: it is linked (its QuickBooks customer is set; nothing else changes).
 *      When several locations have the number, or several sites want one location, the one
 *      whose name or city shares a word with the other wins (as pickSubCustomer does for
 *      Ryder's two "1083" sites); no unique winner means no link.
 *   c. Else a location is created: name = the site's own name, location number = the site
 *      number, code = "<site>-<CITY>" like the routing codes (424-PITTSBURGH; see
 *      locationCode), address from ShipAddr or BillAddr, pickup, no default shop, active,
 *      needs_setup (Admin > Locations shows "From QuickBooks, needs a default shop"; the
 *      first dispatched order saves its shop and fulfillment as the defaults).
 *
 * Off until CDS turns it on: real runs (cron and "Sync now") only write while app_settings
 * "qbo_location_sync" is {"enabled": true}; missing or anything else is off. A dry run
 * (?dry=1 on the cron route) always works, to review the count first.
 *
 * Inactive QuickBooks customers are skipped. Existing locations are never renamed,
 * deactivated, reactivated or deleted. A QuickBooks customer that is itself linked to a
 * portal customer is never a site; a site that belongs to several linked customers goes to
 * the closest one (deepest parent, else the longest name prefix).
 *
 * The planning here is pure (no QuickBooks, no database); ./location-sync-server does the IO.
 */
import { dateTime } from "@/lib/format";
import { QboError } from "./client";
import { locationSiteNumber, siteNumberOf, type QboAddress, type QboCustomerRecord } from "./sub-customer";

export type QboSiteRecord = QboCustomerRecord & { ShipAddr?: QboAddress & { Id?: string } };

/** An active portal customer and the QuickBooks customer it is linked to (qbo_customer_map). */
export type LinkedPortalCustomer = { customerId: string; qboCustomerId: string; name?: string };

/** A portal location (active or not) of a linked customer. */
export type PortalLocationRow = {
  id: string;
  customerId: string;
  code: string;
  locationNumber: string | null;
  name: string;
  city: string | null;
  qboCustomerId: string | null;
};

export type NewLocation = {
  customer_id: string;
  code: string;
  location_number: string | null;
  name: string;
  address_raw: string;
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  market: "US" | "CA";
  qbo_customer_id: string;
  qbo_customer_name: string;
};

export type PlannedLocationLink = { locationId: string; customerId: string; code: string; qboCustomerId: string; qboCustomerName: string };
/**
 * parent_not_found: the linked QuickBooks customer is missing or inactive.
 * several_portal_customers: the site belongs to two linked customers at the same distance.
 * parent_is_site: a QuickBooks customer under a site (its parent has a site number or is linked
 *   to a location), for example "Parent:RYDER - 138-HOUSTON:0138815450".
 * parent_has_sub_customers: a top-level "<Parent> - X" of a linked customer that has
 *   sub-customers (only its sub-customers are its sites).
 */
export type LocationSkipReason = "parent_not_found" | "several_portal_customers" | "parent_is_site" | "parent_has_sub_customers";
/** For parent_not_found, qboCustomerId is the linked QuickBooks id and name the portal customer id. */
export type LocationSkipped = { qboCustomerId: string; name: string; reason: LocationSkipReason; customerId?: string };

/** One portal customer's share of the plan (for the dry-run review). */
export type LocationSyncSummary = { customerId: string; name?: string; created: number; linked: number; unchanged: number; skipped: number };

export type LocationSyncPlan = {
  creates: NewLocation[];
  links: PlannedLocationLink[];
  skipped: LocationSkipped[];
  /** Sites already linked to a location. */
  unchanged: number;
  summary: LocationSyncSummary[];
};

export type LocationSyncInput = {
  qboCustomers: QboSiteRecord[];
  customers: LinkedPortalCustomer[];
  locations: PortalLocationRow[];
};

const NAME_MAX = 500;
const CODE_MAX = 60;

const fqn = (c: Pick<QboCustomerRecord, "DisplayName" | "FullyQualifiedName">) => (c.FullyQualifiedName?.trim() || c.DisplayName.trim());
const fold = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();

/** The name QuickBooks shows for a site, stored on the location: its FullyQualifiedName. */
export const qboCustomerLabel = (c: Pick<QboCustomerRecord, "DisplayName" | "FullyQualifiedName">) => fqn(c).slice(0, NAME_MAX);

export type SiteRelation = { kind: "sub"; ownName: string } | { kind: "prefix"; ownName: string };

/**
 * How `c` is a site of `parent`: a sub-customer at any depth (FullyQualifiedName starts with
 * "<parent>:"), or a top-level customer whose DisplayName is the parent's DisplayName, a
 * separator (" - ", " -", "-" or a space) and more. Any case. Null otherwise.
 */
export function siteRelation(c: QboCustomerRecord, parent: QboCustomerRecord): SiteRelation | null {
  if (c.Id === parent.Id) return null;
  const parentFqn = fold(fqn(parent));
  const own = fqn(c);
  if (fold(own).startsWith(`${parentFqn}:`)) {
    const name = own.slice(own.lastIndexOf(":") + 1).trim();
    return name ? { kind: "sub", ownName: name } : null;
  }
  if (c.ParentRef?.value || c.Job === true || own.includes(":")) return null;
  const parentName = fold(parent.DisplayName);
  const name = c.DisplayName.trim().replace(/\s+/g, " ");
  if (!parentName || !fold(name).startsWith(parentName)) return null;
  const rest = name.slice(parentName.length);
  const m = rest.match(/^(\s*-\s*|\s+)(.*)$/);
  if (!m || !m[2].trim()) return null;
  return { kind: "prefix", ownName: m[2].trim() };
}

/** Depth of a sub-customer below the parent (1 = direct), for "the closest parent wins". */
const depthBelow = (c: QboCustomerRecord, parent: QboCustomerRecord) => fqn(c).split(":").length - fqn(parent).split(":").length;

const codeText = (s: string | null | undefined) =>
  (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The location code, like the routing codes ("424-PITTSBURGH"): the site number and the city,
 * else the name after the site number; without a site number the city or the name; else
 * "QB-<QuickBooks id>". Upper case, at most 60 characters. Uniqueness per customer is added
 * by the planner and the database ("-2", "-3", ...).
 */
export function locationCode(input: { site: string | null; city: string | null; ownName: string; qboId: string }): string {
  const { site, city, ownName, qboId } = input;
  let label = codeText(city);
  if (!label) {
    const m = ownName.match(/\d+/);
    label = codeText(m && site ? ownName.slice((m.index ?? 0) + m[0].length) : ownName);
  }
  const code = site ? (label ? `${site}-${label}` : site) : label || `QB-${codeText(qboId) || "SITE"}`;
  return code.slice(0, CODE_MAX).trim();
}

const COUNTRY_US = /^(US|USA|U\.S\.A?\.?|UNITED STATES( OF AMERICA)?)$/i;
const COUNTRY_CA = /^(CA|CAN|CANADA)$/i;

/** The site's address for the location: ShipAddr when it has a street or city, else BillAddr. */
export function siteAddress(c: QboSiteRecord): Pick<NewLocation, "address_raw" | "address_line1" | "city" | "region" | "postal_code" | "country" | "market"> {
  const has = (a: QboAddress | undefined) => !!(a?.Line1?.trim() || a?.City?.trim());
  const a: QboAddress = (has(c.ShipAddr) ? c.ShipAddr : has(c.BillAddr) ? c.BillAddr : c.ShipAddr ?? c.BillAddr) ?? {};
  const t = (v: string | undefined) => v?.trim() || null;
  const line1 = t(a.Line1);
  const city = t(a.City);
  const region = t(a.CountrySubDivisionCode)?.toUpperCase() ?? null;
  const postal = t(a.PostalCode);
  const rawCountry = t(a.Country);
  const country = !rawCountry || COUNTRY_US.test(rawCountry) ? "US" : COUNTRY_CA.test(rawCountry) ? "CA" : rawCountry;
  const tail = [region, postal].filter(Boolean).join(" ");
  return {
    address_raw: [line1, city, tail].filter(Boolean).join(", "),
    address_line1: line1,
    city,
    region,
    postal_code: postal,
    country,
    market: country === "CA" ? "CA" : "US",
  };
}

const words = (...texts: (string | null | undefined)[]) =>
  new Set(
    texts
      .join(" ")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w)),
  );
const sharesWord = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

/**
 * The single entry that shares a word with `hint`, when the list has more than one. Words in
 * every entry ("RYDER" in every Ryder site) say nothing and are ignored.
 */
function narrow<T>(list: T[], wordsOf: (t: T) => Set<string>, hint: Set<string>): T | null {
  if (list.length === 1) return list[0];
  const sets = list.map(wordsOf);
  const useful = new Set([...hint].filter((w) => !sets.every((s) => s.has(w))));
  const named = list.filter((_, i) => sharesWord(sets[i], useful));
  return named.length === 1 ? named[0] : null;
}

/**
 * The first unique match over several ways of comparing, in order (a location's name before
 * its city before its code: Ryder's "1083-YOUNGSVILLE" location is named "ACADIANA BOTTLING",
 * so the site "RYDER - 1083-ACADIANA BOTTLING" wins over "Ryder - 1083-YOUNGSVILLE").
 */
function narrowInTurn<T>(list: T[], tries: { wordsOf: (t: T) => Set<string>; hint: Set<string> }[]): T | null {
  if (list.length === 1) return list[0];
  for (const t of tries) {
    const found = narrow(list, t.wordsOf, t.hint);
    if (found) return found;
  }
  return null;
}

/** A name or code without case, spacing or punctuation: "Cedar-Falls" = "CEDAR FALLS". */
const nameKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

type Site = { c: QboSiteRecord; customerId: string; ownName: string; site: string | null; parentName: string; ancestors: string[] };

/**
 * The keys a site without a number is matched on: its own name, the part after the first
 * " - " ("Enterprise - Maspeth" -> "Maspeth"), and the name without the parent's name.
 */
function siteKeys(s: Site): Set<string> {
  const keys = [s.ownName];
  const dash = s.ownName.match(/^.*?(?:\s-\s?|\s?-\s)(.+)$/);
  if (dash) keys.push(dash[1]);
  const parent = s.parentName.trim();
  if (parent && s.ownName.toUpperCase().startsWith(parent.toUpperCase())) keys.push(s.ownName.slice(parent.length).replace(/^\s*-?\s*/, ""));
  return new Set(keys.map(nameKey).filter(Boolean));
}

export function planLocationSync(input: LocationSyncInput): LocationSyncPlan {
  const plan: LocationSyncPlan = { creates: [], links: [], skipped: [], unchanged: 0, summary: [] };
  const active = input.qboCustomers.filter((c) => c.Active !== false);
  const byId = new Map(active.map((c) => [c.Id, c]));
  const linkedQboIds = new Set(input.customers.map((c) => c.qboCustomerId));

  const parents: { customerId: string; parent: QboSiteRecord; hasSubs: boolean }[] = [];
  for (const pc of input.customers) {
    const parent = byId.get(pc.qboCustomerId);
    if (!parent) {
      plan.skipped.push({ qboCustomerId: pc.qboCustomerId, name: pc.customerId, reason: "parent_not_found" });
      continue;
    }
    const prefix = `${fold(fqn(parent))}:`;
    parents.push({ customerId: pc.customerId, parent, hasSubs: active.some((c) => fold(fqn(c)).startsWith(prefix)) });
  }

  // Each QuickBooks customer is a site of at most one portal customer: the closest parent.
  // A top-level "<Parent> - X" counts only for a parent without sub-customers (Torque by Ryder).
  const sites: Site[] = [];
  for (const c of [...active].sort((a, b) => a.Id.localeCompare(b.Id, "en", { numeric: true }))) {
    if (linkedQboIds.has(c.Id)) continue;
    type Entry = { customerId: string; ownName: string; parent: QboSiteRecord };
    let best: { score: number; entries: Entry[] } | null = null;
    let blockedBy: string | null = null;
    for (const { customerId, parent, hasSubs } of parents) {
      const rel = siteRelation(c, parent);
      if (!rel) continue;
      if (rel.kind === "prefix" && hasSubs) {
        blockedBy ??= customerId;
        continue;
      }
      const score = rel.kind === "sub" ? depthBelow(c, parent) : 10_000 - fold(parent.DisplayName).length;
      const entry = { customerId, ownName: rel.ownName, parent };
      if (!best || score < best.score) best = { score, entries: [entry] };
      else if (score === best.score && !best.entries.some((e) => e.customerId === customerId)) best.entries.push(entry);
    }
    if (!best) {
      if (blockedBy) plan.skipped.push({ qboCustomerId: c.Id, name: qboCustomerLabel(c), reason: "parent_has_sub_customers", customerId: blockedBy });
      continue;
    }
    if (best.entries.length > 1) {
      plan.skipped.push({ qboCustomerId: c.Id, name: qboCustomerLabel(c), reason: "several_portal_customers" });
      continue;
    }
    const { customerId, ownName, parent } = best.entries[0];
    // The QuickBooks customers between the linked parent and this one ("Parent:Site:Child" -> "Parent:Site").
    const parts = fqn(c).split(":");
    const depth = fqn(parent).split(":").length;
    const ancestors: string[] = [];
    for (let n = depth + 1; n < parts.length; n++) ancestors.push(fold(parts.slice(0, n).join(":")));
    const site: Site = { c, customerId, ownName, site: siteNumberOf(ownName), parentName: parent.DisplayName, ancestors };
    // Under a site with a site number: not a site of its own.
    if (parts.slice(depth, -1).some((p) => siteNumberOf(p))) {
      plan.skipped.push({ qboCustomerId: c.Id, name: qboCustomerLabel(c), reason: "parent_is_site", customerId });
      continue;
    }
    sites.push(site);
  }

  // a. Already linked. A QuickBooks customer under a site linked to a location is skipped.
  const linkedPairs = new Set(input.locations.filter((l) => l.qboCustomerId).map((l) => `${l.customerId}|${l.qboCustomerId}`));
  const linkedFqns = new Set<string>();
  const open: Site[] = [];
  for (const s of sites) {
    if (linkedPairs.has(`${s.customerId}|${s.c.Id}`)) {
      plan.unchanged++;
      linkedFqns.add(fold(fqn(s.c)));
    } else open.push(s);
  }
  const underLinked = (s: Site) => s.ancestors.some((a) => linkedFqns.has(a));
  const skipUnder = (s: Site) =>
    plan.skipped.push({ qboCustomerId: s.c.Id, name: qboCustomerLabel(s.c), reason: "parent_is_site", customerId: s.customerId });
  const candidates = open.filter((s) => {
    if (!underLinked(s)) return true;
    skipUnder(s);
    return false;
  });

  // b. Link: each site picks its location, each location its site.
  //    With a site number: the unlinked locations with that number.
  //    Without one: the unlinked location with the same name or code, else the one unlinked
  //    location without a number in the site's city.
  const unlinked = input.locations.filter((l) => !l.qboCustomerId);
  const siteWords = (s: Site) => words(s.ownName);
  const byName = (l: PortalLocationRow) => words(l.name);
  const byCity = (l: PortalLocationRow) => words(l.city);
  const byCode = (l: PortalLocationRow) => words(l.code);
  const choice = new Map<Site, PortalLocationRow>();
  for (const s of candidates) {
    const mine = unlinked.filter((l) => l.customerId === s.customerId);
    if (s.site) {
      const bySite = mine.filter((l) => locationSiteNumber(l.locationNumber, l.code) === s.site);
      if (!bySite.length) continue;
      const hint = siteWords(s);
      const picked = narrowInTurn(bySite, [byName, byCity, byCode].map((wordsOf) => ({ wordsOf, hint })));
      if (picked) choice.set(s, picked);
      continue;
    }
    const keys = siteKeys(s);
    const named = mine.filter((l) => keys.has(nameKey(l.name)) || keys.has(nameKey(l.code)));
    if (named.length === 1) {
      choice.set(s, named[0]);
      continue;
    }
    if (named.length > 1) continue;
    const cities = new Set([nameKey(siteAddress(s.c).city), ...keys].filter(Boolean));
    const inCity = mine.filter((l) => !locationSiteNumber(l.locationNumber, l.code) && l.city && cities.has(nameKey(l.city)));
    if (inCity.length === 1) choice.set(s, inCity[0]);
  }
  const claimants = new Map<string, Site[]>();
  for (const [s, l] of choice) claimants.set(l.id, [...(claimants.get(l.id) ?? []), s]);
  const linkedSites = new Set<Site>();
  for (const [locationId, list] of claimants) {
    const l = unlinked.find((x) => x.id === locationId)!;
    const winner = narrowInTurn(list, [words(l.name), words(l.city), words(l.code)].map((hint) => ({ wordsOf: siteWords, hint })));
    if (!winner) continue;
    linkedSites.add(winner);
    linkedFqns.add(fold(fqn(winner.c)));
    plan.links.push({ locationId: l.id, customerId: l.customerId, code: l.code, qboCustomerId: winner.c.Id, qboCustomerName: qboCustomerLabel(winner.c) });
  }
  // A site under one linked in this run is not a site of its own either.
  for (const s of candidates) {
    if (!underLinked(s)) continue;
    if (linkedSites.has(s)) {
      linkedSites.delete(s);
      plan.links = plan.links.filter((x) => x.qboCustomerId !== s.c.Id);
    }
    skipUnder(s);
  }

  // c. Create the rest, with a code unique per customer.
  const taken = new Map<string, Set<string>>();
  const codes = (customerId: string) => {
    let set = taken.get(customerId);
    if (!set) {
      set = new Set(input.locations.filter((l) => l.customerId === customerId).map((l) => l.code.trim().toUpperCase()));
      taken.set(customerId, set);
    }
    return set;
  };
  for (const s of candidates) {
    if (linkedSites.has(s) || underLinked(s)) continue;
    const address = siteAddress(s.c);
    const base = locationCode({ site: s.site, city: address.city, ownName: s.ownName, qboId: s.c.Id });
    const used = codes(s.customerId);
    let code = base;
    for (let n = 2; used.has(code); n++) code = `${base}-${n}`;
    used.add(code);
    plan.creates.push({
      customer_id: s.customerId,
      code,
      location_number: s.site,
      name: s.ownName.slice(0, NAME_MAX),
      ...address,
      qbo_customer_id: s.c.Id,
      qbo_customer_name: qboCustomerLabel(s.c),
    });
  }

  const unchangedBy = new Map<string, number>();
  for (const s of sites) if (linkedPairs.has(`${s.customerId}|${s.c.Id}`)) unchangedBy.set(s.customerId, (unchangedBy.get(s.customerId) ?? 0) + 1);
  plan.summary = input.customers.map((c) => ({
    customerId: c.customerId,
    ...(c.name ? { name: c.name } : {}),
    created: plan.creates.filter((x) => x.customer_id === c.customerId).length,
    linked: plan.links.filter((x) => x.customerId === c.customerId).length,
    unchanged: unchangedBy.get(c.customerId) ?? 0,
    skipped: plan.skipped.filter((x) => x.customerId === c.customerId || (x.reason === "parent_not_found" && x.name === c.customerId)).length,
  }));
  return plan;
}

// ---------------------------------------------------------------- run

export type LocationSyncTrigger = "cron" | "manual";

export type LocationSyncDetails = {
  created?: { code: string; qbo_customer_id: string }[];
  linked?: { code: string; qbo_customer_id: string }[];
  skipped?: LocationSkipped[];
  errors?: string[];
};

/** One row of qbo_location_sync_runs (without its id and finished_at). */
export type LocationSyncRunRecord = {
  trigger: LocationSyncTrigger;
  status: "ok" | "failed";
  started_at: string;
  qbo_customers: number;
  created: number;
  linked: number;
  skipped: number;
  details: LocationSyncDetails;
  error: string | null;
};

/** app_settings key of the on/off switch ({"enabled": true} turns the sync on). */
export const LOCATION_SYNC_SETTING_KEY = "qbo_location_sync";
export const LOCATION_SYNC_OFF = "location sync is off";

/** On only for {"enabled": true}; a missing row or any other value is off. */
export function locationSyncEnabled(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { enabled?: unknown }).enabled === true;
}

export type LocationSyncDeps = {
  /** Whether real runs may write (locationSyncEnabled of the app_settings row). */
  enabled(): Promise<boolean>;
  /** Active QuickBooks customers. Throws a QboError of type "Config" when QuickBooks is not connected. */
  listQboCustomers(): Promise<QboSiteRecord[]>;
  loadPortal(): Promise<{ customers: LinkedPortalCustomer[]; locations: PortalLocationRow[] }>;
  /** Creates the location; created false when the customer has one for this QuickBooks customer already. */
  createLocation(location: NewLocation): Promise<{ id: string; created: boolean; code?: string }>;
  /** Sets the QuickBooks customer of an unlinked location; false when it was linked meanwhile. */
  link(link: PlannedLocationLink): Promise<boolean>;
  recordRun(run: LocationSyncRunRecord): Promise<void>;
  now(): Date;
};

export type LocationSyncResult =
  | { status: "skipped"; reason: string }
  | {
      status: "dry_run";
      created: number;
      linked: number;
      skipped: number;
      /** Per portal customer, for the review. */
      summary: LocationSyncSummary[];
      /** Every skipped QuickBooks customer with its reason. */
      skips: LocationSkipped[];
      plan: LocationSyncPlan;
    }
  | { status: "ok" | "failed"; created: number; linked: number; skipped: number; error?: string };

const DETAIL_MAX = 200;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One run. `dryRun`: read QuickBooks and the portal and return the plan; nothing is written or
 * recorded (to count what a first run would create).
 */
export async function runLocationSync(
  deps: LocationSyncDeps,
  trigger: LocationSyncTrigger,
  options: { dryRun?: boolean } = {},
): Promise<LocationSyncResult> {
  if (!options.dryRun && !(await deps.enabled())) return { status: "skipped", reason: LOCATION_SYNC_OFF };
  const startedAt = deps.now().toISOString();
  let qboCustomers: QboSiteRecord[];
  try {
    qboCustomers = await deps.listQboCustomers();
  } catch (e) {
    if (e instanceof QboError && e.faultType === "Config") return { status: "skipped", reason: e.message };
    const error = message(e).slice(0, 2000);
    if (!options.dryRun) {
      await deps.recordRun({ trigger, status: "failed", started_at: startedAt, qbo_customers: 0, created: 0, linked: 0, skipped: 0, details: {}, error });
    }
    return { status: "failed", created: 0, linked: 0, skipped: 0, error };
  }

  if (options.dryRun) {
    const plan = planLocationSync({ qboCustomers, ...(await deps.loadPortal()) });
    return {
      status: "dry_run",
      created: plan.creates.length,
      linked: plan.links.length,
      skipped: plan.skipped.length,
      summary: plan.summary,
      skips: plan.skipped,
      plan,
    };
  }

  const errors: string[] = [];
  const created: { code: string; qbo_customer_id: string }[] = [];
  const linked: { code: string; qbo_customer_id: string }[] = [];
  let plan: LocationSyncPlan = { creates: [], links: [], skipped: [], unchanged: 0, summary: [] };
  try {
    plan = planLocationSync({ qboCustomers, ...(await deps.loadPortal()) });
    for (const l of plan.links) {
      try {
        if (await deps.link(l)) linked.push({ code: l.code, qbo_customer_id: l.qboCustomerId });
      } catch (e) {
        errors.push(`${l.code}: ${message(e)}`);
      }
    }
    for (const c of plan.creates) {
      try {
        const r = await deps.createLocation(c);
        if (r.created) created.push({ code: r.code ?? c.code, qbo_customer_id: c.qbo_customer_id });
      } catch (e) {
        errors.push(`${c.code}: ${message(e)}`);
      }
    }
  } catch (e) {
    errors.push(message(e));
  }

  const status = errors.length ? "failed" : "ok";
  const error = errors.length ? errors.join("; ").slice(0, 2000) : null;
  const record: LocationSyncRunRecord = {
    trigger,
    status,
    started_at: startedAt,
    qbo_customers: qboCustomers.length,
    created: created.length,
    linked: linked.length,
    skipped: plan.skipped.length,
    details: {
      created: created.slice(0, DETAIL_MAX),
      linked: linked.slice(0, DETAIL_MAX),
      skipped: plan.skipped.slice(0, DETAIL_MAX),
      ...(errors.length ? { errors: errors.slice(0, DETAIL_MAX) } : {}),
    },
    error,
  };
  await deps.recordRun(record);
  return { status, created: record.created, linked: record.linked, skipped: record.skipped, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------- status line

export type LocationSyncRunRow = { finished_at: string; status: string; created: number; linked: number; error: string | null };

/**
 * Admin > Locations' status line, from the latest runs (newest first): the last successful
 * run with its counts, and the error of the latest run when it failed.
 */
export function locationSyncStatus(runs: LocationSyncRunRow[]): { text: string; error: string | null } {
  const latest = runs[0];
  const error = latest && latest.status !== "ok" ? `The last QuickBooks sync failed (${dateTime(latest.finished_at)}): ${latest.error ?? "unknown error"}` : null;
  const ok = runs.find((r) => r.status === "ok");
  if (!ok) return { text: "Not synced from QuickBooks yet.", error };
  const created = `${ok.created} new ${ok.created === 1 ? "location" : "locations"}`;
  return { text: `Last synced from QuickBooks: ${dateTime(ok.finished_at)}, ${created}, ${ok.linked} linked.`, error };
}
