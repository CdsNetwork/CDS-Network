/**
 * Customer items: an item that replaces another item on one customer's orders (First
 * Student's "AM" gaskets and clamps, catalog_items.variant_of / variant_customer_id). The
 * database switches every new line (trigger private.use_customer_item,
 * 20261111090000_customer_items_and_line_prices.sql); this file mirrors that rule for what the
 * pickers show, so nobody picks a customer item by hand.
 */

export type CustomerItemRef = {
  id: string;
  active?: boolean;
  variant_of: string | null;
  variant_customer_id: string | null;
};

/** True for an item that replaces another item on one customer's orders. */
export function isCustomerItem(item: Pick<CustomerItemRef, "variant_of">): boolean {
  return item.variant_of !== null && item.variant_of !== undefined;
}

/**
 * The item a new line for `itemId` uses on an order of `customerId`: the active customer item
 * for that customer when there is one; a customer item on another customer's order becomes the
 * regular item. Same rule as the database trigger.
 */
export function lineItemFor(itemId: string, customerId: string | null, catalog: readonly CustomerItemRef[]): string {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  let id = itemId;
  const item = byId.get(id);
  if (item && isCustomerItem(item) && item.variant_customer_id !== customerId) id = item.variant_of as string;
  const replacement = catalog.find((c) => c.variant_of === id && c.variant_customer_id === customerId && c.active !== false);
  return replacement ? replacement.id : id;
}
