/**
 * Matching extracted text to database rows. Always done here in code: ids suggested by the
 * model are never used. Each match carries how it was found and a confidence.
 */
import type {
  AliasRef,
  CatalogRef,
  Component,
  CustomerMatch,
  CustomerRef,
  DomainRef,
  ItemMatch,
  LocationMatch,
  LocationRef,
} from "./types";
import { matchableCatalog } from "./types";

const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Part numbers compare without case, spaces or punctuation: "fs-gsk 1201" equals "FSGSK1201". */
export const partKey = (v: string | null | undefined) => (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Location numbers compare without leading zeros: "0424" equals "424". */
export const locationKey = (v: string | null | undefined) => partKey(v).replace(/^0+(?=.)/, "");

const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function domainMatches(domain: string, registered: string): boolean {
  const d = domain.toLowerCase();
  const r = registered.toLowerCase().replace(/^@/, "");
  return d === r || d.endsWith(`.${r}`);
}

/** A customer named by a request template or by the inbox, as codes and names. */
export type CustomerHint = { codes: string[]; names: string[]; via: "template" | "inbox" };

export type CustomerInput = {
  /** Sender addresses, most trusted first (the original author of a forwarded request first). */
  senders: string[];
  text: string;
  llmCustomerName: string | null;
  /** Template hints are tried before the senders, inbox hints right after them. */
  hints?: CustomerHint[];
};

const nameKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Customers a hint names: the same code, or the same name ignoring case and punctuation, or a
 * name that starts with the other as a whole word ("XPO" names "XPO Logistics", the fleet
 * "Amerit Fleet" names the customer "Amerit").
 */
export function customersForHint(hint: Pick<CustomerHint, "codes" | "names">, customers: CustomerRef[]): CustomerRef[] {
  const codes = new Set(hint.codes.map((c) => c.toUpperCase()));
  const names = hint.names.map(nameKey).filter((n) => n.length >= 3);
  const byCode = customers.filter((c) => codes.has(c.code.toUpperCase()));
  if (byCode.length) return byCode;
  return customers.filter((c) => {
    const name = nameKey(c.name);
    return name.length >= 3 && names.some((n) => n === name || n.startsWith(`${name} `) || name.startsWith(`${n} `));
  });
}

export type CustomerResult = { match: CustomerMatch | null; candidates: CustomerRef[] };

export function matchCustomer(input: CustomerInput, customers: CustomerRef[], domains: DomainRef[]): CustomerResult {
  const byId = new Map(customers.map((c) => [c.id, c]));
  const fromHints = (via: CustomerHint["via"], confidence: number): CustomerResult | null => {
    for (const hint of (input.hints ?? []).filter((h) => h.via === via)) {
      const hits = customersForHint(hint, customers);
      if (hits.length === 1) return { match: { id: hits[0].id, name: hits[0].name, via, confidence }, candidates: [] };
      if (hits.length > 1) return { match: null, candidates: hits };
    }
    return null;
  };

  const template = fromHints("template", 0.98);
  if (template) return template;

  for (const sender of input.senders) {
    const domain = sender.slice(sender.lastIndexOf("@") + 1);
    const hits = [...new Set(domains.filter((d) => domainMatches(domain, d.domain)).map((d) => d.customer_id))]
      .map((id) => byId.get(id))
      .filter((c): c is CustomerRef => !!c);
    if (hits.length === 1) {
      return { match: { id: hits[0].id, name: hits[0].name, via: "sender_domain", confidence: 0.95 }, candidates: [] };
    }
    if (hits.length > 1) return { match: null, candidates: hits };
  }

  const inbox = fromHints("inbox", 0.9);
  if (inbox) return inbox;

  // Customer named in the text ("Ryder", "First Student"). Only a single, unambiguous name counts.
  const named = customers.filter((c) => {
    const name = norm(c.name);
    return name.length >= 3 && new RegExp(String.raw`(?<![a-z0-9])${escape(name)}(?![a-z0-9])`, "i").test(input.text);
  });
  if (named.length === 1) {
    return { match: { id: named[0].id, name: named[0].name, via: "content", confidence: 0.7 }, candidates: [] };
  }

  if (input.llmCustomerName) {
    const wanted = norm(input.llmCustomerName);
    const hits = customers.filter((c) => {
      const name = norm(c.name);
      return name === wanted || (name.length >= 3 && (wanted.includes(name) || name.includes(wanted) && wanted.length >= 4));
    });
    if (hits.length === 1) {
      return { match: { id: hits[0].id, name: hits[0].name, via: "llm_name", confidence: 0.6 }, candidates: [] };
    }
    if (hits.length > 1) return { match: null, candidates: hits };
  }
  return { match: null, candidates: named };
}

export type LocationInput = {
  numbers: string[];
  name: string | null;
  address: string | null;
  zip: string | null;
  text: string;
};

export type LocationResult = { match: LocationMatch | null; candidates: LocationRef[] };

const toMatch = (l: LocationRef, via: LocationMatch["via"], confidence: number): LocationMatch => ({
  id: l.id,
  code: l.code,
  name: l.name,
  via,
  confidence,
});

/** Same order as the Create Work Order location search: number first, then address, then name. */
export function matchLocation(input: LocationInput, locations: LocationRef[]): LocationResult {
  const active = locations;

  for (const raw of input.numbers) {
    const key = locationKey(raw);
    if (!key) continue;
    const hits = active.filter((l) => {
      const code = partKey(l.code);
      return (
        locationKey(l.location_number) === key ||
        locationKey(l.code) === key ||
        // Ryder codes carry the number and the branch name: "424-FAIRVIEW HEIGHTS".
        locationKey(l.code.split(/[-\s]/)[0]) === key ||
        code === partKey(raw)
      );
    });
    if (hits.length === 1) return { match: toMatch(hits[0], "location_number", 0.95), candidates: [] };
    if (hits.length > 1) return { match: null, candidates: hits.slice(0, 5) };
  }

  const zip = input.address?.match(/\b(\d{5})(?:-\d{4})?\b\s*$/)?.[1] ?? input.zip;
  if (zip) {
    const inZip = active.filter((l) => l.postal_code?.slice(0, 5) === zip || new RegExp(String.raw`\b${zip}\b`).test(l.address_raw));
    const street = (input.address ?? input.text).match(/\b(\d{2,6})\s+[A-Za-z]/)?.[1];
    const onStreet = street ? inZip.filter((l) => new RegExp(String.raw`(^|\D)${street}\s`).test(l.address_raw)) : [];
    if (onStreet.length === 1) return { match: toMatch(onStreet[0], "address", 0.85), candidates: [] };
    if (inZip.length === 1) return { match: toMatch(inZip[0], "address", 0.6), candidates: [] };
    if (inZip.length > 1) return { match: null, candidates: (onStreet.length ? onStreet : inZip).slice(0, 5) };
  }

  const wanted = norm(input.name);
  if (wanted.length >= 4) {
    const hits = active.filter((l) => norm(l.name) === wanted || norm(l.name).includes(wanted));
    if (hits.length === 1) return { match: toMatch(hits[0], "name", 0.6), candidates: [] };
    if (hits.length > 1) return { match: null, candidates: hits.slice(0, 5) };
  }
  return { match: null, candidates: [] };
}

export type ItemInput = {
  description: string;
  partNumber: string | null;
  qty: number | null;
  component: Component | null;
  source: "template" | "regex" | "llm";
};

const SERVICE_WORDS = /\b(clean(?:ing|ed)?|bake|flush|blast|service|test)\b/i;
const STOP = new Set(["the", "and", "for", "with", "service", "new", "a", "an", "of", "to", "in", "per", "x"]);

function words(v: string): string[] {
  return norm(v)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

/**
 * How well a description names a catalog item: the share of its words found in the item
 * (recall), plus a small bonus for items without extra words, so "DPF clean" prefers
 * "DPF Cleaning" over "Oil/Fuel Soaked DPF Cleaning".
 */
function nameScore(description: string, item: CatalogRef): { recall: number; score: number } {
  const want = new Set(words(description));
  if (!want.size) return { recall: 0, score: 0 };
  const have = new Set(words(`${item.name} ${item.sku}`));
  const same = (a: string, b: string) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));
  let hit = 0;
  for (const w of want) if ([...have].some((h) => same(w, h))) hit++;
  let used = 0;
  for (const h of have) if ([...want].some((w) => same(w, h))) used++;
  const recall = hit / want.size;
  return { recall, score: recall + 0.1 * (used / have.size) };
}

/** One requested service or part matched to a catalog item, or left unmatched for CDS. */
export function matchItem(input: ItemInput, customerId: string | null, fullCatalog: CatalogRef[], aliases: AliasRef[]): ItemMatch {
  const catalog = matchableCatalog(fullCatalog);
  const qty = input.qty && input.qty > 0 && input.qty < 1000 ? input.qty : 1;
  const base = { description: input.description, part_number: input.partNumber, qty, source: input.source };
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const hit = (item: CatalogRef, via: ItemMatch["via"], confidence: number): ItemMatch => ({
    ...base,
    catalog_item_id: item.id,
    sku: item.sku,
    name: item.name,
    via,
    confidence,
  });

  const key = partKey(input.partNumber);
  if (key) {
    if (customerId) {
      const alias = aliases.find((a) => a.customer_id === customerId && partKey(a.customer_part_number) === key);
      const item = alias && byId.get(alias.catalog_item_id);
      if (item) return hit(item, "customer_alias", 0.95);
    }
    const bySku = catalog.find((c) => partKey(c.sku) === key);
    if (bySku) return hit(bySku, "sku", 0.95);
    const byOe = catalog.find((c) => (c.oe_cross ?? "").split(/[,;\/\s]+/).some((oe) => oe && partKey(oe) === key));
    if (byOe) return hit(byOe, "oe_cross", 0.85);
  }

  // A cleaning request for a component ("DPF clean") goes to the service for that component.
  const text = `${input.description} ${input.component ?? ""}`;
  const component = input.component && input.component !== "other" ? input.component : null;
  const isService = SERVICE_WORDS.test(input.description) || (!!component && !key);
  const pool = catalog.filter((c) => (isService ? c.category === "service" : c.category !== "service"));
  let best: { item: CatalogRef; recall: number; score: number } | null = null;
  let tie = false;
  for (const item of pool) {
    let { recall, score } = nameScore(text, item);
    if (component && !new RegExp(String.raw`\b${component}\b`, "i").test(`${item.name} ${item.sku}`)) {
      recall = Math.min(recall, 0.2);
      score = recall;
    }
    if (!best || score > best.score + 1e-9) {
      best = { item, recall, score };
      tie = false;
    } else if (Math.abs(score - best.score) < 1e-9) tie = true;
  }
  if (best && !tie && best.recall >= 0.5) return hit(best.item, "name", best.recall >= 0.75 ? 0.7 : 0.5);
  return { ...base, catalog_item_id: null, sku: null, name: null, via: "none", confidence: 0 };
}

export const __test = { domainMatches, nameScore };
