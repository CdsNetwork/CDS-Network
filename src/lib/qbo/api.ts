import "server-only";
import { qboRequest, type QboApi } from "./client";
import type { QboInvoicePayload } from "./invoice";
import type { QboLookups } from "./invoice-qbo";
import type { QboCustomerRecord } from "./sub-customer";

/**
 * The QuickBooks calls the portal makes. Entity shapes (only the fields used here):
 * https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
 * https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/companyinfo
 * https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/preferences
 * Queries: https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries
 * (at most 1000 rows per page, paged with STARTPOSITION and MAXRESULTS).
 */

export type QboItem = { Id: string; Name: string; FullyQualifiedName?: string; Sku?: string; Type?: string; Active?: boolean };
export type QboCustomer = { Id: string; DisplayName: string; CompanyName?: string; Active?: boolean };

const PAGE = 1000;
/** Upper bound so a very large company cannot make a page hang. */
const MAX_ROWS = 10_000;

async function queryAll<T>(api: QboApi, entity: "Item" | "Customer", where: string): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 1; start <= MAX_ROWS; start += PAGE) {
    const res = await qboRequest<{ QueryResponse?: Record<string, T[] | undefined> }>(api, "GET", "query", {
      query: { query: `select * from ${entity} where ${where} startposition ${start} maxresults ${PAGE}` },
    });
    const page = res.QueryResponse?.[entity] ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

export function listItems(api: QboApi): Promise<QboItem[]> {
  return queryAll<QboItem>(api, "Item", "Active = true");
}

export function listCustomers(api: QboApi): Promise<QboCustomer[]> {
  return queryAll<QboCustomer>(api, "Customer", "Active = true");
}

export async function companyName(api: QboApi): Promise<string | null> {
  const res = await qboRequest<{ CompanyInfo?: { CompanyName?: string; LegalName?: string } }>(
    api,
    "GET",
    `companyinfo/${encodeURIComponent(api.realmId)}`,
  );
  return res.CompanyInfo?.CompanyName ?? res.CompanyInfo?.LegalName ?? null;
}

/**
 * Preferences.TaxPrefs.PartnerTaxEnabled is true when Automated Sales Tax is on. Sales tax
 * cannot be turned on through the API; CDS does that in QuickBooks.
 */
export async function automatedSalesTax(api: QboApi): Promise<boolean | null> {
  const res = await qboRequest<{ Preferences?: { TaxPrefs?: { PartnerTaxEnabled?: boolean } } }>(api, "GET", "preferences");
  const v = res.Preferences?.TaxPrefs?.PartnerTaxEnabled;
  return typeof v === "boolean" ? v : null;
}

/** A string literal for a QuickBooks query: quotes and backslashes escaped with a backslash. */
export function qboQuoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export async function getCustomer(api: QboApi, id: string): Promise<QboCustomerRecord | null> {
  const res = await qboRequest<{ Customer?: QboCustomerRecord }>(api, "GET", `customer/${encodeURIComponent(id)}`);
  return res.Customer ?? null;
}

/** Active customers under a parent (direct or deeper; the caller checks ParentRef). */
export function listSubCustomers(api: QboApi, parentFqn: string): Promise<QboCustomerRecord[]> {
  return queryAll<QboCustomerRecord>(api, "Customer", `FullyQualifiedName LIKE ${qboQuoted(`${parentFqn}:%`)} AND Active = true`);
}

/** Preferences.SalesFormsPrefs: the classic sales form custom fields (see ./custom-fields). */
export async function salesFormsPrefs(api: QboApi): Promise<{ CustomField?: unknown[] } | null> {
  const res = await qboRequest<{ Preferences?: { SalesFormsPrefs?: { CustomField?: unknown[] } } }>(api, "GET", "preferences");
  return res.Preferences?.SalesFormsPrefs ?? null;
}

/**
 * The newest invoices with every custom field (include=enhancedAllCustomFields), to learn
 * the DefinitionIds of custom fields that are not in Preferences.
 */
export async function recentInvoiceCustomFields(api: QboApi): Promise<{ CustomField?: { DefinitionId?: string; Name?: string }[] }[]> {
  const res = await qboRequest<{ QueryResponse?: { Invoice?: { CustomField?: { DefinitionId?: string; Name?: string }[] }[] } }>(
    api,
    "GET",
    "query",
    { query: { query: "select * from Invoice orderby MetaData.CreateTime desc maxresults 50", include: "enhancedAllCustomFields" } },
  );
  return res.QueryResponse?.Invoice ?? [];
}

/** The QuickBooks calls the invoice-time lookups use (./invoice-qbo). */
export function qboLookups(api: QboApi): QboLookups {
  return {
    getCustomer: (id) => getCustomer(api, id),
    listSubCustomers: (fqn) => listSubCustomers(api, fqn),
    salesFormsPrefs: () => salesFormsPrefs(api),
    recentInvoiceCustomFields: () => recentInvoiceCustomFields(api),
  };
}

export type CreatedInvoice = { Id: string; DocNumber?: string; TotalAmt?: number };

/** Creates the invoice. The same requestId never creates a second invoice. */
export async function createInvoice(api: QboApi, payload: QboInvoicePayload, requestId: string): Promise<CreatedInvoice> {
  const res = await qboRequest<{ Invoice?: CreatedInvoice }>(api, "POST", "invoice", { body: payload, requestId });
  if (!res.Invoice?.Id) throw new Error("QuickBooks did not return the new invoice");
  return res.Invoice;
}
