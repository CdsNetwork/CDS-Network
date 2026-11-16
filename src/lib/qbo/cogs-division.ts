/**
 * The Division (QuickBooks Department) of a shop's bill (CDS, 2026-11-16): the customer's
 * COGS division, the counterpart of the INCOME division its invoices carry (qbo_customer_division,
 * for example RYDER INCOME on the invoice and RYDER COGS on the bill). Used when the customer
 * has no qbo_customer_cogs_division row yet: picked from QuickBooks's active Departments on the
 * customer's first bill and remembered there (./bill-run). Never stops a bill: no match, two
 * matches or a failure means the bill goes without a Division.
 */

/** Department entity (only the fields used): https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/department */
export type QboDepartment = { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean };
export type CogsDivision = { id: string; name: string };

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The customer's COGS division among the active Departments, or null. Tried in order, each
 * ignoring case and extra spaces: the income division with INCOME replaced by COGS, then
 * "<customer name> COGS". A step that points at two divisions gives null rather than a guess.
 */
export function matchCogsDivision(customer: { incomeDivision: string | null; customerName: string | null }, departments: QboDepartment[]): CogsDivision | null {
  const active = departments.filter((d) => d.Active !== false && d.Id?.trim() && d.Name?.trim() && d.Id.trim().length <= 50);
  const income = norm(customer.incomeDivision);
  const name = norm(customer.customerName);
  const keys = [/\bincome\b/.test(income) ? income.replace(/\bincome\b/g, "cogs") : "", name ? `${name} cogs` : ""];
  for (const key of keys) {
    if (!key) continue;
    const hits = active.filter((d) => norm(d.Name) === key || norm(d.FullyQualifiedName) === key);
    const ids = new Set(hits.map((d) => d.Id.trim()));
    if (ids.size > 1) return null;
    if (ids.size === 1) return { id: hits[0].Id.trim(), name: hits[0].Name.trim().slice(0, 500) };
  }
  return null;
}
