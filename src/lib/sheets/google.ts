/**
 * Sheets API v4 over fetch, signed in as a Google service account (OAuth 2.0 JWT bearer
 * grant, https://developers.google.com/identity/protocols/oauth2/service-account): the
 * service account's private key signs a short JWT (RS256, Node crypto), Google answers an
 * access token for the spreadsheets scope. No Google SDK: four endpoints are all it needs.
 */
import { createSign } from "node:crypto";
import type { SheetsConfig } from "./config";
import type { SheetsClient, TabInfo } from "./sync";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

type Fetch = typeof fetch;

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** The signed JWT assertion for the token request. */
export function serviceAccountAssertion(config: Pick<SheetsConfig, "email" | "privateKey">, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: config.email, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(config.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

async function failure(what: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; error_description?: string };
    detail = typeof body.error === "string" ? `${body.error} ${body.error_description ?? ""}` : (body.error?.message ?? "");
  } catch {
    // no JSON body
  }
  const hint =
    res.status === 403 || res.status === 404
      ? " (is the sheet shared with the service account's email as Editor, and is the Sheets API enabled?)"
      : "";
  return new Error(`Google Sheets ${what} failed: HTTP ${res.status} ${detail.trim().slice(0, 300)}${hint}`.trim());
}

export async function accessToken(config: SheetsConfig, fetchImpl: Fetch = fetch, now = Date.now()): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(config, Math.floor(now / 1000)),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await failure("sign-in", res);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Google Sheets sign-in failed: no access token");
  return body.access_token;
}

type SheetProps = { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } };

/** A SheetsClient for one spreadsheet; signs in on the first call. */
export function googleSheetsClient(config: SheetsConfig, fetchImpl: Fetch = fetch): SheetsClient {
  let token: Promise<string> | null = null;
  const base = `${API}/${encodeURIComponent(config.sheetId)}`;

  async function call<T>(what: string, method: string, url: string, body?: unknown): Promise<T> {
    token ??= accessToken(config, fetchImpl);
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw await failure(what, res);
    return (await res.json()) as T;
  }

  const info = (s: SheetProps): TabInfo => ({
    sheetId: s.properties.sheetId,
    rowCount: s.properties.gridProperties?.rowCount ?? 0,
    columnCount: s.properties.gridProperties?.columnCount ?? 0,
  });

  return {
    async ensureTab(title) {
      const meta = await call<{ sheets?: SheetProps[] }>("read", "GET", `${base}?fields=sheets.properties`);
      const found = meta.sheets?.find((s) => s.properties.title === title);
      if (found) return info(found);
      const res = await call<{ replies: { addSheet: SheetProps }[] }>("add tab", "POST", `${base}:batchUpdate`, {
        requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }],
      });
      return info(res.replies[0].addSheet);
    },
    async read(range) {
      const res = await call<{ values?: unknown[][] }>(
        "read",
        "GET",
        `${base}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`,
      );
      return res.values ?? [];
    },
    async write(data) {
      await call("write", "POST", `${base}/values:batchUpdate`, { valueInputOption: "RAW", data });
    },
    async grow(sheetId, rows, columns) {
      const requests = [
        rows > 0 && { appendDimension: { sheetId, dimension: "ROWS", length: rows } },
        columns > 0 && { appendDimension: { sheetId, dimension: "COLUMNS", length: columns } },
      ].filter(Boolean);
      if (requests.length) await call("resize", "POST", `${base}:batchUpdate`, { requests });
    },
    async deleteRows(sheetId, rowIndexes) {
      const requests = [...rowIndexes]
        .sort((a, b) => b - a)
        .map((i) => ({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: i, endIndex: i + 1 } } }));
      if (requests.length) await call("delete rows", "POST", `${base}:batchUpdate`, { requests });
    },
  };
}
