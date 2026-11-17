import "server-only";
import { listBillAccounts, listCustomers, listItems, listTerms, listVendors, type QboAccount, type QboCustomer, type QboItem, type QboTerm } from "./api";
import type { QboVendor } from "./bill";
import type { QboApi } from "./client";
import { qboApi } from "./tokens";

/**
 * The QuickBooks lists the admin pickers use (customers, items, vendors, expense accounts,
 * terms). Reading them all takes many seconds (paged, 1000 rows per request), so they are kept
 * on this server for a few minutes per QuickBooks company: switching admin tabs or saving a
 * mapping does not read them again. Only list rows are kept, never tokens. A failed read is
 * not kept. A record added in QuickBooks shows here within QBO_LISTS_TTL_MS.
 */
export const QBO_LISTS_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** For tests. */
export function clearQboListsCache(): void {
  cache.clear();
}

function cached<T>(api: QboApi, name: string, load: () => Promise<T>): Promise<T> {
  const key = `${api.environment}:${api.realmId}:${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < QBO_LISTS_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  const entry = { at: Date.now(), value };
  cache.set(key, entry);
  value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return value;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

export type QboMappingLists = { customers: QboCustomer[] | null; items: QboItem[] | null; error: string | null };

/** QuickBooks customers and items when connected; null lists mean "type the id by hand". */
export async function qboMappingLists(connected: boolean): Promise<QboMappingLists> {
  if (!connected) return { customers: null, items: null, error: null };
  try {
    const api = await qboApi();
    const [customers, items] = await Promise.all([
      cached(api, "customers", () => listCustomers(api)),
      cached(api, "items", () => listItems(api)),
    ]);
    return { customers, items, error: null };
  } catch (e) {
    return {
      customers: null,
      items: null,
      error: `QuickBooks lists could not be loaded (${message(e)}). Enter ids by hand or reload.`,
    };
  }
}

export type QboBillLists = { lists: { vendors: QboVendor[]; accounts: QboAccount[]; terms: QboTerm[] } | null; error: string | null };

/** QuickBooks vendors, expense accounts and terms for shop bills when connected. */
export async function qboBillLists(connected: boolean): Promise<QboBillLists> {
  if (!connected) return { lists: null, error: null };
  try {
    const api = await qboApi();
    const [vendors, accounts, terms] = await Promise.all([
      cached(api, "vendors", () => listVendors(api)),
      cached(api, "bill-accounts", () => listBillAccounts(api)),
      cached(api, "terms", () => listTerms(api)),
    ]);
    return { lists: { vendors, accounts, terms }, error: null };
  } catch (e) {
    return { lists: null, error: `QuickBooks vendors and accounts could not be loaded (${message(e)}). Enter ids by hand or reload.` };
  }
}
