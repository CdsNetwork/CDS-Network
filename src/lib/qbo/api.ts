import "server-only";
import { qboRequest, type QboApi } from "./client";
import type { QboInvoicePayload } from "./invoice";

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

export type CreatedInvoice = { Id: string; DocNumber?: string; TotalAmt?: number };

/** Creates the invoice. The same requestId never creates a second invoice. */
export async function createInvoice(api: QboApi, payload: QboInvoicePayload, requestId: string): Promise<CreatedInvoice> {
  const res = await qboRequest<{ Invoice?: CreatedInvoice }>(api, "POST", "invoice", { body: payload, requestId });
  if (!res.Invoice?.Id) throw new Error("QuickBooks did not return the new invoice");
  return res.Invoice;
}
