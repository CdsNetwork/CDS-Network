/**
 * Google Sheets backup settings. A Google service account signs in with its own key (no
 * person's login): either GOOGLE_SHEETS_SA_JSON (the whole JSON key file Google gives) or
 * GOOGLE_SHEETS_SA_EMAIL + GOOGLE_SHEETS_SA_KEY (the key's client_email and private_key),
 * plus BACKUP_SHEET_ID (the id in the sheet's URL). The sheet must be shared with the
 * service account's email as Editor. Anything missing: null, and the backup does nothing.
 */
export type SheetsConfig = { email: string; privateKey: string; sheetId: string };

export function sheetsConfig(env: Record<string, string | undefined> = process.env): SheetsConfig | null {
  const sheetId = env.BACKUP_SHEET_ID?.trim();
  if (!sheetId) return null;
  let email = env.GOOGLE_SHEETS_SA_EMAIL?.trim();
  let key = env.GOOGLE_SHEETS_SA_KEY;
  const json = env.GOOGLE_SHEETS_SA_JSON?.trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as { client_email?: string; private_key?: string };
      email = parsed.client_email?.trim() || email;
      key = parsed.private_key || key;
    } catch {
      return null;
    }
  }
  // A key pasted into an env var often keeps its line breaks as the two characters "\n".
  const privateKey = key?.replace(/\\n/g, "\n").trim();
  if (!email || !privateKey || !privateKey.includes("PRIVATE KEY")) return null;
  return { email, privateKey, sheetId };
}
