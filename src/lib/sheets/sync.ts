/**
 * Google Sheets backup (CDS decision 2026-10-22: a new sheet, "DISPATCH - APP BACK UP", not
 * the dispatch sheet CDS works in). One row per work order on the tab "Work Orders", keyed by
 * the WO number in column A:
 *
 *   * the header row is written when missing and repaired when it differs;
 *   * a work order already in the sheet is rewritten in place, only when its row changed;
 *   * a work order not in the sheet is added below the last row (the grid grows as needed);
 *   * a WO number found on several rows (copied by hand, or two runs at once) keeps its first
 *     row and the extra rows are deleted, so a rerun never leaves duplicates.
 *
 * An incremental run reads only the work orders changed since the watermark (the start of
 * the last successful run, minus a few minutes of overlap); a full run reads every work order.
 * A full run happens on the first run, when the last successful full run is more than a day
 * old (it catches changes that do not move a timestamp, such as a shipping cost edit), and on
 * "Back up now". Each run is one integration_sync row (system 'sheets'); a failure is recorded
 * there and never touches the portal. No database or network access here: everything comes in
 * through BackupDeps.
 */
import { columnLetter, HEADER, sameRow, toRow, type BackupOrder, type Cell } from "./columns";

export const TAB = "Work Orders";
const WIDTH = HEADER.length;
const LAST_COL = columnLetter(WIDTH);
/** Overlap so a change committed while the last run was reading is not missed. */
export const OVERLAP_MS = 5 * 60_000;
export const FULL_EVERY_MS = 24 * 60 * 60_000;
/** Rows per values:batchUpdate request (keeps each request well under the API's size limit). */
const WRITE_CHUNK = 500;

export type TabInfo = { sheetId: number; rowCount: number; columnCount: number };

/** The few Sheets API v4 calls the backup needs (google.ts; a fake in the unit tests). */
export interface SheetsClient {
  /** The tab's grid id and size; creates the tab (header row frozen) when it is missing. */
  ensureTab(title: string): Promise<TabInfo>;
  /** Every row of A1:<last column>, trailing empty cells and rows left out. */
  read(range: string): Promise<unknown[][]>;
  /** values:batchUpdate with valueInputOption RAW (text is stored as text, never run as a formula). */
  write(data: { range: string; values: Cell[][] }[]): Promise<void>;
  /** Adds rows / columns at the end of the grid. */
  grow(sheetId: number, rows: number, columns: number): Promise<void>;
  /** Deletes whole rows (0-based indexes). */
  deleteRows(sheetId: number, rowIndexes: number[]): Promise<void>;
}

export type LastRuns = { watermark: string | null; lastFullAt: string | null };

export type BackupDeps = {
  sheets: SheetsClient;
  lastRuns(): Promise<LastRuns>;
  /** Work orders changed at or after `since`, or every work order when since is null. */
  loadOrders(since: string | null): Promise<BackupOrder[]>;
  recordRun(run: BackupRun): Promise<void>;
  now(): number;
};

export type BackupRun = {
  full: boolean;
  status: "ok" | "error";
  /** Start of this run (ISO): the next incremental run reads changes from here, minus the overlap. */
  startedAt: string;
  /** Work order rows in the sheet after the run. */
  rows: number;
  added: number;
  updated: number;
  unchanged: number;
  duplicatesRemoved: number;
  headerWritten: boolean;
  error: string | null;
};

const q = (title: string) => `'${title.replace(/'/g, "''")}'`;
const keyOf = (cell: unknown) => String(cell ?? "").trim().replace(/^WO-/i, "");

export async function runBackup(deps: BackupDeps, options: { full?: boolean } = {}): Promise<BackupRun> {
  const started = deps.now();
  const run: BackupRun = {
    full: false,
    status: "ok",
    startedAt: new Date(started).toISOString(),
    rows: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    duplicatesRemoved: 0,
    headerWritten: false,
    error: null,
  };
  try {
    const last = await deps.lastRuns();
    run.full =
      !!options.full || !last.watermark || !last.lastFullAt || started - Date.parse(last.lastFullAt) >= FULL_EVERY_MS;
    const since = run.full ? null : new Date(Date.parse(last.watermark!) - OVERLAP_MS).toISOString();
    const orders = await deps.loadOrders(since);

    let tab = await deps.sheets.ensureTab(TAB);
    let rows = await deps.sheets.read(`${q(TAB)}!A1:${LAST_COL}`);

    // Extra rows of a WO number that is already higher up go first (bottom up, indexes stay valid).
    const seen = new Set<string>();
    const extra: number[] = [];
    rows.forEach((r, i) => {
      const k = i === 0 ? "" : keyOf(r[0]);
      if (!k) return;
      if (seen.has(k)) extra.push(i);
      else seen.add(k);
    });
    if (extra.length) {
      await deps.sheets.deleteRows(tab.sheetId, extra);
      run.duplicatesRemoved = extra.length;
      tab = await deps.sheets.ensureTab(TAB);
      rows = await deps.sheets.read(`${q(TAB)}!A1:${LAST_COL}`);
    }

    const writes: { range: string; values: Cell[][] }[] = [];
    if (!sameRow(rows[0] ?? [], HEADER)) {
      writes.push({ range: `${q(TAB)}!A1:${LAST_COL}1`, values: [[...HEADER]] });
      run.headerWritten = true;
    }

    const rowOf = new Map<string, number>();
    rows.forEach((r, i) => {
      const k = i === 0 ? "" : keyOf(r[0]);
      if (k) rowOf.set(k, i + 1);
    });

    const added: Cell[][] = [];
    for (const o of [...orders].sort((a, b) => a.woNumber - b.woNumber)) {
      const values = toRow(o);
      const at = rowOf.get(String(o.woNumber));
      if (!at) added.push(values);
      else if (sameRow(rows[at - 1] ?? [], values)) run.unchanged++;
      else {
        writes.push({ range: `${q(TAB)}!A${at}:${LAST_COL}${at}`, values: [values] });
        run.updated++;
      }
    }

    // New rows go below the last used row; the grid grows first when it is too small.
    const firstNew = Math.max(rows.length, 1) + 1;
    const needRows = firstNew - 1 + added.length;
    if (needRows > tab.rowCount || WIDTH > tab.columnCount) {
      await deps.sheets.grow(tab.sheetId, Math.max(0, needRows - tab.rowCount), Math.max(0, WIDTH - tab.columnCount));
    }
    for (let i = 0; i < added.length; i += WRITE_CHUNK) {
      const chunk = added.slice(i, i + WRITE_CHUNK);
      const from = firstNew + i;
      writes.push({ range: `${q(TAB)}!A${from}:${LAST_COL}${from + chunk.length - 1}`, values: chunk });
    }
    run.added = added.length;

    for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
      const batch = writes.slice(i, i + WRITE_CHUNK);
      if (batch.length) await deps.sheets.write(batch);
    }
    run.rows = rowOf.size + added.length;
  } catch (e) {
    run.status = "error";
    run.error = (e instanceof Error ? e.message : String(e)).slice(0, 1500);
  }
  await deps.recordRun(run);
  return run;
}

/** The integration_sync row of one run. The watermark (run start) is kept in external_id. */
export function runRow(run: BackupRun) {
  const note =
    run.status === "ok"
      ? `${run.rows} orders in the sheet; added ${run.added}, updated ${run.updated}, unchanged ${run.unchanged}` +
        (run.duplicatesRemoved ? `, duplicate rows removed ${run.duplicatesRemoved}` : "") +
        (run.headerWritten ? ", header row written" : "")
      : run.error;
  return {
    system: "sheets",
    entity: run.full ? "backup_full" : "backup",
    direction: "push" as const,
    status: run.status,
    external_id: run.startedAt,
    error: note,
  };
}

/** "123 orders in the sheet; ..." -> 123. */
export function rowsFromNote(note: string | null | undefined): number | null {
  const m = /^(\d+) orders in the sheet/.exec(note ?? "");
  return m ? Number(m[1]) : null;
}
