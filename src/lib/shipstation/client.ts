/**
 * A small typed client for the ShipStation API (V2). No database access here.
 *
 * Error format: a failed call returns
 *   { "request_id": "...", "errors": [{ "error_source", "error_type", "error_code", "message" }] }
 * (seen live 2026-10-18). Rate limits are per endpoint; an exceeded limit answers HTTP 429,
 * usually with a Retry-After header.
 */
import { SHIPSTATION_API_BASE } from "./config";

export class ShipStationError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when ShipStation could not be reached. */
    readonly status: number,
    readonly requestId?: string,
    /** Seconds ShipStation asked to wait (Retry-After on a 429), when it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ShipStationError";
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }

  /** ShipStation answered and refused the request: nothing was created or charged. */
  get rejected(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

type ErrorBody = { request_id?: string; errors?: { message?: string }[] };

/** Readable message from a ShipStation error body. */
export function errorMessage(body: unknown, fallback: string): string {
  const errors = (body as ErrorBody | null)?.errors;
  if (!Array.isArray(errors) || !errors.length) return fallback;
  const message = errors
    .map((e) => (typeof e?.message === "string" ? e.message.trim() : ""))
    .filter(Boolean)
    .join("; ");
  return message || fallback;
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

/** One API call. `path` is relative to /v2/, for example "rates" or "labels/se-1/void". */
export async function shipStationRequest<T>(
  apiKey: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  options: { body?: unknown; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(`${SHIPSTATION_API_BASE}/${path}`, {
      method,
      headers: {
        "API-Key": apiKey,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
  } catch (e) {
    throw new ShipStationError(`ShipStation could not be reached (${e instanceof Error ? e.message : "network error"})`, 0);
  }
  const body = await readJson(res);
  const requestId = (body as ErrorBody | null)?.request_id;
  if (res.status === 429) {
    const wait = res.headers.get("retry-after");
    const seconds = wait && /^\d{1,5}$/.test(wait.trim()) ? Number(wait.trim()) : undefined;
    throw new ShipStationError(
      `ShipStation is busy (rate limit reached). Try again${seconds !== undefined ? ` in ${seconds} seconds` : " in a minute"}.`,
      429,
      requestId,
      seconds,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ShipStationError("ShipStation refused the API key. Check SHIPSTATION_API_KEY.", res.status, requestId);
  }
  if (!res.ok) {
    throw new ShipStationError(errorMessage(body, `ShipStation returned HTTP ${res.status}`), res.status, requestId);
  }
  return body as T;
}
