/**
 * Confirm step for destructive admin actions. With no message the action runs at once;
 * with a message it runs only when the user agrees.
 */
export function confirmed(text: string | undefined, ask: (text: string) => boolean = (t) => window.confirm(t)): boolean {
  if (!text) return true;
  return ask(text);
}

export const DISCONNECT_QUICKBOOKS_CONFIRM =
  "Disconnect QuickBooks? This revokes the portal's connection to the QuickBooks company. Invoices cannot be created " +
  "until it is connected again, and reconnecting needs a QuickBooks Primary Admin or Company Admin to sign in and approve it.";

export function removeCustomerLinkConfirm(customer: string, qboCustomer: string): string {
  return `Remove the link between ${customer} and QuickBooks customer "${qboCustomer}"? Invoices for this customer cannot be created until it is linked again.`;
}

export function removeItemLinkConfirm(item: string, scope: string, qboItem: string): string {
  return `Remove the link between catalog item ${item} (${scope}) and QuickBooks item "${qboItem}"?`;
}

export function removeMeasurementItemConfirm(customer: string, componentType: string): string {
  return `Remove the measurement item for ${componentType} (${customer})? Invoices then get no measurement line for it.`;
}

export function removePartNumberConfirm(customer: string, item: string, partNumber: string): string {
  return `Remove customer part number ${partNumber} for ${item} (${customer})?`;
}
