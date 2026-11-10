/**
 * Matching a work order's location to the QuickBooks sub-customer of its parent customer.
 * Pure: no database, no network.
 *
 * CDS keeps large fleets as one parent customer with a sub-customer per site, for example
 * parent "Ryder Fleet Services" with the sub-customer whose FullyQualifiedName is
 * "Ryder Fleet Services:RYDER - 297-COLORADO SPRINGS CO" (DisplayName is the part after the
 * last colon). The site number is the first run of digits in the sub-customer's own name, and
 * in the portal the first run of digits in the location number (or the location code when
 * there is none), the same number the Location picker sorts by.
 *
 * Customer fields: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer
 * (ParentRef is the immediate parent, Job is true for a sub-customer).
 */

export type QboAddress = {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  Line5?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
};

export type QboCustomerRecord = {
  Id: string;
  DisplayName: string;
  FullyQualifiedName?: string;
  Active?: boolean;
  Job?: boolean;
  ParentRef?: { value: string; name?: string };
  BillAddr?: QboAddress & { Id?: string };
};

/** The site number as digits without leading zeros ("0297" -> "297"); null when there is none. */
export function siteNumberOf(text: string | null | undefined): string | null {
  const m = (text ?? "").match(/\d+/);
  if (!m) return null;
  return m[0].replace(/^0+(?=\d)/, "");
}

/** The site number of a portal location: its location number, else its code. */
export function locationSiteNumber(locationNumber: string | null | undefined, code: string | null | undefined): string | null {
  return siteNumberOf(locationNumber) ?? siteNumberOf(code);
}

/** The sub-customer's own name: the part of FullyQualifiedName after the last colon. */
export function ownName(c: Pick<QboCustomerRecord, "DisplayName" | "FullyQualifiedName">): string {
  const fqn = c.FullyQualifiedName?.trim();
  if (fqn) {
    const at = fqn.lastIndexOf(":");
    return at >= 0 ? fqn.slice(at + 1).trim() : fqn;
  }
  return c.DisplayName.trim();
}

const words = (s: string | null | undefined) =>
  (s ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));

export type SubCustomerMatch =
  | { kind: "match"; customer: QboCustomerRecord }
  | { kind: "none" }
  | { kind: "ambiguous"; names: string[] };

/**
 * The active direct sub-customer of `parentId` for this site. When several have the site
 * number (Ryder has two sites "1083"), the one whose name shares a word with the location
 * name or city wins; otherwise there is no unique match.
 */
export function pickSubCustomer(
  candidates: QboCustomerRecord[],
  parentId: string,
  site: string,
  location: { name?: string | null; city?: string | null } = {},
): SubCustomerMatch {
  const children = candidates.filter((c) => c.ParentRef?.value === parentId && c.Active !== false);
  const bySite = children.filter((c) => siteNumberOf(ownName(c)) === site);
  if (bySite.length === 1) return { kind: "match", customer: bySite[0] };
  if (!bySite.length) return { kind: "none" };
  const hints = new Set([...words(location.name), ...words(location.city)]);
  const named = bySite.filter((c) => words(ownName(c)).some((w) => hints.has(w)));
  if (named.length === 1) return { kind: "match", customer: named[0] };
  return { kind: "ambiguous", names: bySite.map((c) => c.FullyQualifiedName ?? c.DisplayName) };
}

/** The parent's billing address for the invoice (without QuickBooks' own address id). */
export function billAddrFrom(c: QboCustomerRecord | null | undefined): QboAddress | null {
  const a = c?.BillAddr;
  if (!a) return null;
  const out: QboAddress = {};
  for (const k of ["Line1", "Line2", "Line3", "Line4", "Line5", "City", "CountrySubDivisionCode", "PostalCode", "Country"] as const) {
    const v = a[k]?.trim();
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
