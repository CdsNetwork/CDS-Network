/**
 * Helpers for saving another form's unsaved changes before running an action
 * (Approve & Dispatch saves pending Edit order changes first).
 */

export type Result = { error?: string; [key: string]: unknown };

function textEntries(form: FormData): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue; // file inputs are ignored
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  }
  for (const list of map.values()) list.sort();
  return map;
}

/** True when any text field differs between the two snapshots (value order per key is ignored). */
export function formChanged(initial: FormData, current: FormData): boolean {
  const a = textEntries(initial);
  const b = textEntries(current);
  if (a.size !== b.size) return true;
  for (const [key, values] of a) {
    const other = b.get(key);
    if (!other || other.length !== values.length) return true;
    if (values.some((v, i) => v !== other[i])) return true;
  }
  return false;
}

/**
 * Saves the pending edits (when there are any), then runs the action.
 * A failed save stops here and its error is returned instead of running the action.
 */
export async function runWithPendingEdits({
  pending,
  save,
  run,
}: {
  pending: FormData | null;
  save: (pending: FormData) => Promise<Result>;
  run: () => Promise<Result>;
}): Promise<Result> {
  if (pending) {
    const saved = await save(pending);
    if (saved.error) return { error: `Edit order was not saved: ${saved.error}` };
  }
  const result = await run();
  if (pending && result.error) return { error: `${result.error} (Edit order changes were saved.)` };
  return result;
}
