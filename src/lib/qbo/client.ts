/**
 * A small typed client for the QuickBooks Online Accounting API and Intuit's OAuth token
 * endpoint. No database access here: callers pass the access token (see tokens.ts).
 *
 * Error format: a failed Accounting API call returns
 *   { "Fault": { "Error": [{ "Message", "Detail", "code", "element" }], "type" } }
 * (https://developer.intuit.com/app/developer/qbo/docs/develop/troubleshooting/error-codes).
 * Every response carries an intuit_tid header that Intuit support asks for.
 */
import {
  QBO_API_BASE,
  QBO_MINOR_VERSION,
  QBO_REVOKE_URL,
  QBO_TOKEN_URL,
  type QboConfig,
  type QboEnvironment,
} from "./config";

export class QboError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when QuickBooks could not be reached. */
    readonly status: number,
    /** Intuit fault type and code, when QuickBooks returned a fault. */
    readonly faultType?: string,
    readonly code?: string,
    readonly intuitTid?: string,
  ) {
    super(message);
    this.name = "QboError";
  }

  /** QuickBooks answered and refused the request: nothing was created. */
  get rejected(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 408 && this.status !== 429;
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }
}

type Fault = { Fault?: { type?: string; Error?: { Message?: string; Detail?: string; code?: string }[] } };

/** Readable message from an Intuit fault body. */
export function faultMessage(body: unknown, fallback: string): { message: string; type?: string; code?: string } {
  const fault = (body as Fault | null)?.Fault;
  const errors = fault?.Error ?? [];
  if (!errors.length) return { message: fallback };
  const message = errors
    .map((e) => {
      const msg = e.Message?.trim() ?? "";
      const detail = e.Detail?.trim() ?? "";
      return detail && detail !== msg ? `${msg}: ${detail}` : msg || detail;
    })
    .filter(Boolean)
    .join("; ");
  return { message: message || fallback, type: fault?.type, code: errors[0]?.code };
}

async function readJson(res: Response): Promise<unknown> {
  const raw = await res.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 500) };
  }
}

export type QboApi = {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
};

/**
 * One Accounting API call. `path` is relative to /v3/company/<realmId>/. `requestId` is
 * Intuit's idempotency key (query parameter requestid, at most 50 characters): QuickBooks
 * answers a repeated id with the original response instead of creating the entity again
 * (https://developer.intuit.com/app/developer/qbo/docs/learn/learn-basic-field-definitions).
 */
export async function qboRequest<T>(
  api: QboApi,
  method: "GET" | "POST",
  path: string,
  options: { query?: Record<string, string>; body?: unknown; requestId?: string; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const url = new URL(`${QBO_API_BASE[api.environment]}/v3/company/${encodeURIComponent(api.realmId)}/${path}`);
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
  if (options.requestId) {
    if (options.requestId.length > 50) throw new Error("QuickBooks request ids are at most 50 characters");
    url.searchParams.set("requestid", options.requestId);
  }

  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(url, {
      method,
      headers: {
        Authorization: `Bearer ${api.accessToken}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new QboError(`QuickBooks could not be reached (${e instanceof Error ? e.message : "network error"})`, 0);
  }
  const tid = res.headers.get("intuit_tid") ?? undefined;
  const body = await readJson(res);
  if (!res.ok) {
    const fault = faultMessage(body, `QuickBooks returned HTTP ${res.status}`);
    throw new QboError(fault.message, res.status, fault.type, fault.code, tid);
  }
  // Some faults come back with HTTP 200.
  if ((body as Fault | null)?.Fault) {
    const fault = faultMessage(body, "QuickBooks returned an error");
    throw new QboError(fault.message, 400, fault.type, fault.code, tid);
  }
  return body as T;
}

// ---------------------------------------------------------------- OAuth tokens

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  /** Seconds; about 3600. */
  expires_in: number;
  /** Seconds until the refresh token expires (about 100 days, rolling). */
  x_refresh_token_expires_in?: number;
};

function basicAuth(config: QboConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
}

/** POST to the token endpoint (client_secret_basic, form encoded, per the discovery document). */
async function tokenCall(config: QboConfig, form: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(QBO_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuth(config),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new QboError(`Intuit could not be reached (${e instanceof Error ? e.message : "network error"})`, 0);
  }
  const body = (await readJson(res)) as (Partial<TokenResponse> & { error?: string; error_description?: string }) | null;
  if (!res.ok || !body?.access_token || !body.refresh_token) {
    const reason = body?.error_description || body?.error || `HTTP ${res.status}`;
    throw new QboError(`Intuit refused the token request (${reason})`, res.ok ? 400 : res.status, "OAuth", body?.error);
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: Number(body.expires_in ?? 3600),
    x_refresh_token_expires_in: body.x_refresh_token_expires_in === undefined ? undefined : Number(body.x_refresh_token_expires_in),
  };
}

export function exchangeCode(config: QboConfig, code: string): Promise<TokenResponse> {
  return tokenCall(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri });
}

/** Intuit may return a new refresh token on every refresh; always store the one returned. */
export function refreshTokens(config: QboConfig, refreshToken: string): Promise<TokenResponse> {
  return tokenCall(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Revokes the app's access to the company (best effort on disconnect). */
export async function revokeToken(config: QboConfig, token: string): Promise<void> {
  const res = await fetch(QBO_REVOKE_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(config), Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new QboError(`Intuit did not revoke the token (HTTP ${res.status})`, res.status);
}
