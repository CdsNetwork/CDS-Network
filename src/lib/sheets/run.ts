import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sheetsConfig } from "./config";
import { googleSheetsClient } from "./google";
import { lastBackupRuns, loadBackupOrders, recordBackupRun } from "./source";
import { runBackup, type BackupRun } from "./sync";

/**
 * One backup run against the configured sheet, or null when the backup is not configured
 * (nothing is read, written or logged). `db` must be the service role client.
 */
export async function runSheetsBackup(db: SupabaseClient, options: { full?: boolean } = {}): Promise<BackupRun | null> {
  const config = sheetsConfig();
  if (!config) return null;
  return runBackup(
    {
      sheets: googleSheetsClient(config),
      lastRuns: () => lastBackupRuns(db),
      loadOrders: (since) => loadBackupOrders(db, since),
      recordRun: (run) => recordBackupRun(db, run),
      now: () => Date.now(),
    },
    options,
  );
}
