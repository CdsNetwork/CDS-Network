/**
 * The component manufacturers a shop picks from (Sarah, CDS, 2026-11-20), in her order. The
 * database keeps the same list in shop_save_component
 * (20261121000000_manufacturer_list_customer_part_number.sql): change both together.
 *
 * Components saved before the list keep their typed value: it is offered as an extra choice
 * so saving the component again does not wipe it, and it can only change to the list.
 */
export const MANUFACTURERS = ["CUMMINS", "DETROIT", "VOLVO", "ISUZU", "NAVISTAR", "INTERNATIONAL", "N/A"] as const;

const onList = (v: string) => (MANUFACTURERS as readonly string[]).includes(v);

/** The choices for a component: an older typed value first, as it is, then the list. */
export function manufacturerOptions(saved: string | null | undefined): string[] {
  const old = saved?.trim() ?? "";
  return old && !onList(old) ? [old, ...MANUFACTURERS] : [...MANUFACTURERS];
}

/** A value may be saved when it is empty, on the list, or the value the component already has. */
export function manufacturerAllowed(value: string, saved: string | null | undefined): boolean {
  const v = value.trim();
  return v === "" || onList(v) || v === (saved?.trim() ?? "");
}
