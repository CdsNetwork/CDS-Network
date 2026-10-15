type Json = Record<string, unknown>;

/** Columns that change on every save and mean nothing to a person reading the log. */
export const AUDIT_SKIP_FIELDS = new Set(["id", "updated_at", "created_at", "updated_by"]);

/** Fields of an update whose value changed, leaving out bookkeeping columns. */
export function changedFields(oldData: Json, newData: Json): string[] {
  return Object.keys(newData).filter(
    (k) => !AUDIT_SKIP_FIELDS.has(k) && JSON.stringify(oldData[k]) !== JSON.stringify(newData[k]),
  );
}

/**
 * False for an update that changed only bookkeeping columns. The database stops writing
 * these from 2026-10-15 (20261015030000); older rows are hidden on the Change log tab.
 */
export function isVisibleChange(row: { action: string; old_data: Json | null; new_data: Json | null }): boolean {
  if (row.action !== "update" || !row.old_data || !row.new_data) return true;
  return changedFields(row.old_data, row.new_data).length > 0;
}
