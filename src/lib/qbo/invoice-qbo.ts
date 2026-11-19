/**
 * What the invoice needs from QuickBooks itself, looked up when the invoice is created:
 *   * the sub-customer for the work order's site (./sub-customer), billed with the parent's
 *     billing address while ShipAddr stays the site;
 *   * the DefinitionIds of the invoice custom fields "Fleet Number" and "PO Number"
 *     (./custom-fields);
 *   * the QuickBooks items' own sales descriptions, for lines that have no other invoice text
 *     (ItemTextLine in ./invoice).
 * None may stop the invoice: anything not found leaves today's invoice (billed to the
 * parent, no custom field, our item names) and adds a note that is shown to CDS and kept on
 * the sync row.
 * Only an expired or revoked token is passed on, so the caller can refresh it and retry.
 * One exception: an invoice with a shipping charge for a company whose sales forms do not
 * allow shipping (Preferences.SalesFormsPrefs.AllowShipping false) is stopped with
 * ShippingNotAllowedError (./invoice-shipping) before anything is sent. When the preference
 * cannot be read the invoice is sent, and a refusal is explained by shippingRefusalMessage.
 * A GESi shipping line ("Shipping & Handling Fee (G)") gets the id of the active QuickBooks item
 * with that name; when there is none, or it cannot be looked up, GesiShippingItemError stops
 * the invoice before anything is sent.
 *
 * The QuickBooks calls are passed in (QboLookups, see ./api), so this file has no network
 * code of its own.
 */
import type { createClient } from "@/lib/supabase/server";
import { lineDescription, type ItemTextLine, type QboInvoicePayload } from "./invoice";
import {
  GESI_SHIPPING_ITEM_NAME,
  GesiShippingItemError,
  isGesiShippingLine,
  isShippingLine,
  shippingAmountOf,
  ShippingNotAllowedError,
} from "./invoice-shipping";
import { classicCustomFieldDefs, fillCustomFields, invoiceCustomFieldDefs, type CustomFieldDef } from "./custom-fields";
import { siteRelation } from "./location-sync";
import { billAddrFrom, ownName, pickSubCustomer, siteNumberOf, type QboCustomerRecord } from "./sub-customer";

export const FLEET_NUMBER_FIELD = "Fleet Number";
export const PO_NUMBER_FIELD = "PO Number";

/** What the invoice-time lookups need to know about the work order. */
export type InvoiceTarget = {
  locationId: string | null;
  /** locationSiteNumber(location_number, code) */
  siteNumber: string | null;
  locationName: string | null;
  city: string | null;
  poNumber: string | null;
  unitNumber: string | null;
  /**
   * The QuickBooks customer that is this site (customer_locations.qbo_customer_id, set by the
   * location sync, ./location-sync): the invoice goes to it directly.
   */
  qboCustomerId?: string | null;
  qboCustomerName?: string | null;
};

export type QboLookups = {
  getCustomer(id: string): Promise<QboCustomerRecord | null>;
  /** Active customers whose FullyQualifiedName starts with "<parentFqn>:". */
  listSubCustomers(parentFqn: string): Promise<QboCustomerRecord[]>;
  salesFormsPrefs(): Promise<{ CustomField?: unknown[]; AllowShipping?: boolean } | null>;
  /** Recent invoices read with include=enhancedAllCustomFields. */
  recentInvoiceCustomFields(): Promise<{ CustomField?: { DefinitionId?: string; Name?: string }[] }[]>;
  /** The items whose Name is exactly this (QuickBooks returns active items only). */
  findItemsByName?(name: string): Promise<{ Id: string; Name: string; Active?: boolean }[]>;
  /** The items with these ids (one query), for their sales description. */
  getItems(ids: string[]): Promise<{ Id: string; Description?: string }[]>;
};

export type ResolvedInvoice = {
  payload: QboInvoicePayload;
  notes: string[];
  /** The sub-customer billed (to remember for the location), null when billed to the parent. */
  subCustomer: { id: string; name: string } | null;
};

/** Key of qbo_item_descriptions: the QuickBooks item name without case or spaces. */
export function itemDescriptionKey(name: string): string {
  return name.toUpperCase().replace(/\s+/g, "");
}

/** An expired or revoked token: the caller refreshes it and tries again. */
function unauthorized(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { unauthorized?: unknown }).unauthorized === true;
}

const why = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

/**
 * The location's own QuickBooks customer (set by the location sync), when it is still active
 * and still a site of the linked customer: a sub-customer is billed with the parent's billing
 * address (as the site-number match), a top-level site ("<parent> - Tampa") with its own.
 * Otherwise a note, and the caller falls back to the site-number lookup.
 */
async function resolveLocationCustomer(
  lookups: QboLookups,
  parentId: string,
  parentName: string,
  target: InvoiceTarget,
): Promise<{ customer: QboCustomerRecord; parent: QboCustomerRecord | null } | { note: string }> {
  const id = target.qboCustomerId!.trim();
  const label = target.qboCustomerName?.trim() || `id ${id}`;
  const fallback = (why: string) => ({ note: `The location's QuickBooks customer ${label} ${why}, so the sub-customer was looked up by site number.` });
  const site = await lookups.getCustomer(id).catch((e: unknown) => {
    if (unauthorized(e)) throw e;
    return null;
  });
  if (!site) return fallback("was not found in QuickBooks");
  if (site.Active === false) return fallback("is inactive in QuickBooks");
  const parent = await lookups.getCustomer(parentId);
  if (!parent) return fallback(`could not be checked (QuickBooks customer ${parentName} was not found)`);
  const relation = siteRelation(site, parent);
  if (!relation) return fallback(`is not a site of ${parent.FullyQualifiedName?.trim() || parent.DisplayName} in QuickBooks`);
  return { customer: site, parent: relation.kind === "sub" ? parent : null };
}

async function resolveSubCustomer(
  lookups: QboLookups,
  parentId: string,
  parentName: string,
  target: InvoiceTarget,
  cachedId: string | null,
): Promise<{ customer: QboCustomerRecord; parent: QboCustomerRecord } | { note: string | null }> {
  const parent = await lookups.getCustomer(parentId);
  if (!parent) return { note: `QuickBooks customer ${parentName} was not found, so no sub-customer was looked up.` };
  const name = parent.FullyQualifiedName?.trim() || parent.DisplayName;
  const site = target.siteNumber;

  if (cachedId && site) {
    // A remembered id that QuickBooks no longer has (deleted, other company) means a new lookup.
    const cached = await lookups.getCustomer(cachedId).catch((e: unknown) => {
      if (unauthorized(e)) throw e;
      return null;
    });
    if (cached && cached.ParentRef?.value === parentId && cached.Active !== false && siteNumberOf(ownName(cached)) === site) {
      return { customer: cached, parent };
    }
  }

  const children = (await lookups.listSubCustomers(name)).filter((c) => c.ParentRef?.value === parentId && c.Active !== false);
  // A customer without sub-customers is billed as before, without a note.
  if (!children.length) return { note: null };
  if (!site) return { note: `The location has no site number to find its QuickBooks sub-customer, so the invoice is billed to ${name}.` };
  const match = pickSubCustomer(children, parentId, site, { name: target.locationName, city: target.city });
  if (match.kind === "match") return { customer: match.customer, parent };
  if (match.kind === "ambiguous") {
    return {
      note: `Several QuickBooks sub-customers of ${name} have site number ${site} (${match.names.join(", ")}), so the invoice is billed to ${name}.`,
    };
  }
  return { note: `No QuickBooks sub-customer of ${name} has site number ${site}, so the invoice is billed to ${name}.` };
}

/**
 * The definitions to fill, those learned from recent invoices first: their (enhanced) ids are
 * the ones QuickBooks keeps when a classic and a newer field are sent together, and they have
 * no 31-character limit. The classic ids from Preferences remain the fallback, for example
 * in a company without invoices yet.
 */
async function customFieldDefs(lookups: Pick<QboLookups, "salesFormsPrefs" | "recentInvoiceCustomFields">): Promise<CustomFieldDef[]> {
  const classic = classicCustomFieldDefs(await lookups.salesFormsPrefs());
  try {
    return [...invoiceCustomFieldDefs(await lookups.recentInvoiceCustomFields()), ...classic];
  } catch (e) {
    if (unauthorized(e)) throw e;
    // Without earlier invoices only the classic fields are known; the missing ones get their own note.
    return classic;
  }
}

/** Puts each QuickBooks item's own sales description on the lines that have no other text. */
async function applyItemText(lookups: QboLookups, payload: QboInvoicePayload, itemText: ItemTextLine[]): Promise<string | null> {
  if (!itemText.length) return null;
  try {
    const items = await lookups.getItems([...new Set(itemText.map((t) => t.qboItemId))]);
    const text = new Map(items.map((i) => [i.Id, i.Description?.trim()]));
    const lines = [...payload.Line];
    for (const t of itemText) {
      const description = text.get(t.qboItemId);
      const line = lines[t.index];
      if (!description || !line || isShippingLine(line) || line.SalesItemLineDetail.ItemRef.value !== t.qboItemId) continue;
      lines[t.index] = { ...line, Description: lineDescription(t.line, t.alias, description) };
    }
    payload.Line = lines;
    return null;
  } catch (e) {
    if (unauthorized(e)) throw e;
    return `The QuickBooks item descriptions could not be read (${why(e)}), so the lines show our item names.`;
  }
}

/** The lines with the QuickBooks id of "Shipping & Handling Fee (G)" on the GESi shipping line. */
async function withGesiShippingItem(lookups: QboLookups, lines: QboInvoicePayload["Line"]): Promise<QboInvoicePayload["Line"]> {
  if (!lookups.findItemsByName) throw new GesiShippingItemError("the portal cannot look it up in QuickBooks");
  let items: { Id: string; Name: string; Active?: boolean }[];
  try {
    items = await lookups.findItemsByName(GESI_SHIPPING_ITEM_NAME);
  } catch (e) {
    if (unauthorized(e)) throw e;
    throw new GesiShippingItemError(`it could not be looked up in QuickBooks (${why(e)})`);
  }
  const found = items.filter((i) => i.Name === GESI_SHIPPING_ITEM_NAME && i.Active !== false);
  if (found.length === 0) throw new GesiShippingItemError("QuickBooks has no active item with that name");
  if (found.length > 1) throw new GesiShippingItemError("QuickBooks has more than one active item with that name");
  const ref = { value: found[0].Id, name: GESI_SHIPPING_ITEM_NAME };
  return lines.map((l) => (isGesiShippingLine(l) ? { ...l, SalesItemLineDetail: { ...l.SalesItemLineDetail, ItemRef: ref } } : l)) as QboInvoicePayload["Line"];
}

/**
 * The invoice with its sub-customer, custom fields and item descriptions, and notes for
 * whatever was left out.
 */
export async function resolveInvoiceQbo(
  lookups: QboLookups,
  base: QboInvoicePayload,
  target: InvoiceTarget,
  cachedSubCustomerId: string | null,
  itemText: ItemTextLine[] = [],
): Promise<ResolvedInvoice> {
  const payload: QboInvoicePayload = { ...base };
  const notes: string[] = [];
  let subCustomer: ResolvedInvoice["subCustomer"] = null;
  const parentName = base.CustomerRef.name ?? `id ${base.CustomerRef.value}`;
  // Preferences are read once for the shipping check and the custom fields.
  let prefs: ReturnType<QboLookups["salesFormsPrefs"]> | null = null;
  const prefsOnce: QboLookups["salesFormsPrefs"] = () => (prefs ??= lookups.salesFormsPrefs());

  const shipping = shippingAmountOf(base);
  if (shipping > 0) {
    let allowed: boolean | undefined;
    try {
      allowed = (await prefsOnce())?.AllowShipping;
    } catch (e) {
      if (unauthorized(e)) throw e;
      prefs = null;
    }
    if (allowed === false) throw new ShippingNotAllowedError(shipping);
  }
  if (base.Line.some(isGesiShippingLine)) payload.Line = await withGesiShippingItem(lookups, base.Line);

  try {
    let r: { customer: QboCustomerRecord; parent: QboCustomerRecord | null } | { note: string | null } = { note: null };
    if (target.qboCustomerId?.trim()) {
      r = await resolveLocationCustomer(lookups, base.CustomerRef.value, parentName, target);
      if ("note" in r && r.note) notes.push(r.note);
    }
    if (!("customer" in r)) r = await resolveSubCustomer(lookups, base.CustomerRef.value, parentName, target, cachedSubCustomerId);
    if ("customer" in r) {
      payload.CustomerRef = { value: r.customer.Id, name: r.customer.DisplayName };
      const bill = billAddrFrom(r.parent);
      if (bill) payload.BillAddr = bill;
      subCustomer = { id: r.customer.Id, name: r.customer.FullyQualifiedName ?? r.customer.DisplayName };
    } else if (r.note) {
      notes.push(r.note);
    }
  } catch (e) {
    if (unauthorized(e)) throw e;
    notes.push(`The QuickBooks sub-customer could not be looked up (${why(e)}), so the invoice is billed to ${parentName}.`);
  }

  const values = [
    { name: FLEET_NUMBER_FIELD, value: target.unitNumber },
    { name: PO_NUMBER_FIELD, value: target.poNumber },
  ].filter((v) => v.value?.trim());
  if (values.length) {
    try {
      const defs = await customFieldDefs({ ...lookups, salesFormsPrefs: prefsOnce });
      const filled = fillCustomFields(defs, values);
      if (filled.fields.length) payload.CustomField = filled.fields;
      for (const name of filled.missing) {
        notes.push(`QuickBooks has no invoice custom field named "${name}", so it is not filled (the value is still in the invoice message).`);
      }
      for (const name of filled.clipped) notes.push(`${name} is cut to 31 characters, the QuickBooks limit for that field.`);
    } catch (e) {
      if (unauthorized(e)) throw e;
      notes.push(`The QuickBooks custom fields could not be read (${why(e)}), so ${values.map((v) => v.name).join(" and ")} are not filled.`);
    }
  }

  const itemNote = await applyItemText(lookups, payload, itemText);
  if (itemNote) notes.push(itemNote);

  return { payload, notes, subCustomer };
}

type Db = Awaited<ReturnType<typeof createClient>>;

/** The sub-customer found earlier for this location under this parent (qbo_location_customer_map). */
export async function cachedSubCustomer(supabase: Db, locationId: string | null, parentId: string): Promise<string | null> {
  if (!locationId) return null;
  try {
    const { data, error } = await supabase
      .from("qbo_location_customer_map")
      .select("qbo_customer_id")
      .eq("location_id", locationId)
      .eq("qbo_parent_id", parentId)
      .maybeSingle();
    if (error) return null;
    return (data as { qbo_customer_id: string } | null)?.qbo_customer_id ?? null;
  } catch {
    return null;
  }
}

/** Remembers the sub-customer for the location. Best effort: a failure only means another lookup next time. */
export async function saveSubCustomer(
  supabase: Db,
  locationId: string | null,
  parentId: string,
  sub: { id: string; name: string },
): Promise<void> {
  if (!locationId) return;
  try {
    const { error } = await supabase
      .from("qbo_location_customer_map")
      .upsert(
        { location_id: locationId, qbo_parent_id: parentId, qbo_customer_id: sub.id, qbo_display_name: sub.name.slice(0, 500) },
        { onConflict: "location_id" },
      );
    if (error) console.error(`qbo_location_customer_map: could not remember ${sub.id} for location ${locationId}: ${error.message}`);
  } catch (e) {
    console.error(`qbo_location_customer_map: could not remember ${sub.id} for location ${locationId}: ${why(e)}`);
  }
}
