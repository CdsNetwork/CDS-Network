/**
 * QuickBooks invoice custom fields ("Fleet Number", "PO Number"). Pure: no database, no network.
 *
 * An invoice custom field is sent as
 *   CustomField: [{ DefinitionId, Name, Type: "StringType", StringValue }]
 * and QuickBooks needs the DefinitionId of a field CDS created in QuickBooks. There are two
 * places to learn it, by the field's name:
 *   * Classic custom fields: Preferences.SalesFormsPrefs.CustomField lists
 *     "SalesFormsPrefs.SalesCustomName<n>" (the name) and "SalesFormsPrefs.UseSalesCustom<n>"
 *     (on or off); the DefinitionId is n (1 to 3), and a value holds at most 31 characters.
 *     https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/preferences
 *   * Custom fields of the newer experience are not in Preferences. Their DefinitionId (the
 *     "legacyIDV2" of the GraphQL custom field API) comes back on existing invoices read with
 *     include=enhancedAllCustomFields, so it is learned from recent invoices.
 *     https://developer.intuit.com/app/developer/qbo/docs/workflows/create-custom-fields
 * A field that cannot be found is left off the invoice with a note; it never stops the invoice.
 */

export type CustomFieldDef = { id: string; name: string; classic: boolean };

export type QboCustomField = { DefinitionId: string; Name: string; Type: "StringType"; StringValue: string };

/** Classic custom field values are at most 31 characters. */
export const CLASSIC_MAX = 31;

export const fieldKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

type PrefField = { Name?: string; Type?: string; StringValue?: string; BooleanValue?: boolean; CustomField?: PrefField[] };

function flatten(list: PrefField[] | undefined, out: PrefField[] = []): PrefField[] {
  for (const f of list ?? []) {
    if (Array.isArray(f.CustomField)) flatten(f.CustomField, out);
    else out.push(f);
  }
  return out;
}

/** The classic sales form custom fields that are named and turned on. */
export function classicCustomFieldDefs(salesFormsPrefs: { CustomField?: unknown[] } | null | undefined): CustomFieldDef[] {
  const names = new Map<string, string>();
  const used = new Map<string, boolean>();
  for (const f of flatten(salesFormsPrefs?.CustomField as PrefField[] | undefined)) {
    const name = f.Name ?? "";
    const n = name.match(/SalesCustomName(\d+)$/);
    if (n && f.StringValue?.trim()) names.set(n[1], f.StringValue.trim());
    const u = name.match(/UseSalesCustom(\d+)$/);
    if (u && typeof f.BooleanValue === "boolean") used.set(u[1], f.BooleanValue);
  }
  return [...names]
    .filter(([id]) => used.get(id) !== false)
    .map(([id, name]) => ({ id, name, classic: true }));
}

type InvoiceField = { DefinitionId?: string; Name?: string };

/** Custom fields seen on existing invoices (read with include=enhancedAllCustomFields). */
export function invoiceCustomFieldDefs(invoices: { CustomField?: InvoiceField[] }[]): CustomFieldDef[] {
  const seen = new Map<string, CustomFieldDef>();
  for (const inv of invoices) {
    for (const f of inv.CustomField ?? []) {
      const id = f.DefinitionId?.trim();
      const name = f.Name?.trim();
      if (id && name && !seen.has(fieldKey(name))) seen.set(fieldKey(name), { id, name, classic: false });
    }
  }
  return [...seen.values()];
}

/** Names from `wanted` that no definition has. */
export function missingFields(defs: CustomFieldDef[], wanted: string[]): string[] {
  const have = new Set(defs.map((d) => fieldKey(d.name)));
  return wanted.filter((w) => !have.has(fieldKey(w)));
}

/**
 * The CustomField entries for the values that have a definition (first definition with the
 * name wins), the names without one, and the values cut to the classic limit.
 */
export function fillCustomFields(
  defs: CustomFieldDef[],
  values: { name: string; value: string | null | undefined }[],
): { fields: QboCustomField[]; missing: string[]; clipped: string[] } {
  const byName = new Map<string, CustomFieldDef>();
  for (const d of defs) if (!byName.has(fieldKey(d.name))) byName.set(fieldKey(d.name), d);
  const fields: QboCustomField[] = [];
  const missing: string[] = [];
  const clipped: string[] = [];
  for (const { name, value } of values) {
    const v = value?.trim();
    if (!v) continue;
    const def = byName.get(fieldKey(name));
    if (!def) {
      missing.push(name);
      continue;
    }
    let text = v;
    if (def.classic && text.length > CLASSIC_MAX) {
      text = text.slice(0, CLASSIC_MAX);
      clipped.push(name);
    }
    fields.push({ DefinitionId: def.id, Name: def.name, Type: "StringType", StringValue: text });
  }
  return { fields, missing, clipped };
}
