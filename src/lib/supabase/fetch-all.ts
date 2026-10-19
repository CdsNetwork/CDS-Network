/**
 * Reads every row of a query in pages. PostgREST returns at most 1000 rows per request
 * (max_rows), so a plain select silently stops there.
 *
 * The query must be ordered by a unique column, or end with one (for example
 * `.order("code").order("id")`), so that pages neither overlap nor skip rows.
 */

export const PAGE_SIZE = 1000;

/** Guard against a query that never returns a short page. */
const DEFAULT_MAX_ROWS = 100_000;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };
export type PageQuery<T> = (from: number, to: number) => PromiseLike<PageResult<T>>;

export async function fetchAll<T>(page: PageQuery<T>, options: { maxRows?: number } = {}): Promise<T[]> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    if (from >= maxRows) throw new Error(`The query returned more than ${maxRows} rows`);
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return out;
  }
}

/** fetchAll with the result shape of a single Supabase query: rows, or the error. */
export async function fetchAllSettled<T>(
  page: PageQuery<T>,
  options: { maxRows?: number } = {},
): Promise<{ data: T[]; error: null } | { data: null; error: { message: string } }> {
  try {
    return { data: await fetchAll(page, options), error: null };
  } catch (e) {
    return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
  }
}
