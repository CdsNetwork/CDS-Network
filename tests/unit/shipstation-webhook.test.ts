import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createJwksKeyFinder, tokenMatches, verifyWebhook } from "@/lib/shipstation/webhook-verify";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "webhook-signing-key-1", alg: "RS256", use: "sig" };
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const NOW = new Date("2026-10-18T20:00:00Z");
const BODY = JSON.stringify({ resource_type: "API_TRACK", resource_url: "https://api.shipengine.com/v1/tracking?x=1" });

function signed(body: string, timestamp: string, key = privateKey): string {
  return sign("sha256", Buffer.from(`${timestamp}.${body}`), key).toString("base64");
}

const findKey = async (kid: string) => (kid === "webhook-signing-key-1" ? jwk : null);

function headers(over: Partial<Record<string, string | null>> = {}) {
  const timestamp = "2026-10-18T19:58:30Z";
  const base: Record<string, string | null> = {
    "x-shipengine-rsa-sha256-key-id": "webhook-signing-key-1",
    "x-shipengine-rsa-sha256-signature": signed(BODY, timestamp),
    "x-shipengine-timestamp": timestamp,
    ...over,
  };
  return new Headers(Object.entries(base).filter((e): e is [string, string] => e[1] !== null));
}

describe("verifyWebhook", () => {
  it("accepts a correctly signed, recent request", async () => {
    expect(await verifyWebhook({ headers: headers(), rawBody: BODY, now: NOW, findKey })).toEqual({ ok: true });
  });

  it("answers 404 when a signature header is missing", async () => {
    for (const name of ["x-shipengine-rsa-sha256-key-id", "x-shipengine-rsa-sha256-signature", "x-shipengine-timestamp"]) {
      const r = await verifyWebhook({ headers: headers({ [name]: null }), rawBody: BODY, now: NOW, findKey });
      expect(r).toMatchObject({ ok: false, status: 404 });
    }
  });

  it("answers 400 when the timestamp is more than 5 minutes off, either way", async () => {
    for (const timestamp of ["2026-10-18T19:54:59Z", "2026-10-18T20:05:01Z", "yesterday"]) {
      const h = headers({ "x-shipengine-timestamp": timestamp, "x-shipengine-rsa-sha256-signature": signed(BODY, timestamp) });
      expect(await verifyWebhook({ headers: h, rawBody: BODY, now: NOW, findKey })).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("answers 401 for a changed body", async () => {
    const r = await verifyWebhook({ headers: headers(), rawBody: BODY.replace("API_TRACK", "API_BATCH"), now: NOW, findKey });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("answers 401 for a signature made with another key", async () => {
    const timestamp = "2026-10-18T19:58:30Z";
    const h = headers({ "x-shipengine-rsa-sha256-signature": signed(BODY, timestamp, other.privateKey) });
    expect(await verifyWebhook({ headers: h, rawBody: BODY, now: NOW, findKey })).toMatchObject({ ok: false, status: 401 });
  });

  it("answers 401 for an unknown key id", async () => {
    const r = await verifyWebhook({ headers: headers({ "x-shipengine-rsa-sha256-key-id": "nope" }), rawBody: BODY, now: NOW, findKey });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("answers 401 for a timestamp that was not the one signed", async () => {
    const h = headers({ "x-shipengine-timestamp": "2026-10-18T19:59:00Z" });
    expect(await verifyWebhook({ headers: h, rawBody: BODY, now: NOW, findKey })).toMatchObject({ ok: false, status: 401 });
  });

  it("answers 401 when the key cannot be loaded", async () => {
    const failing = async () => {
      throw new Error("network");
    };
    expect(await verifyWebhook({ headers: headers(), rawBody: BODY, now: NOW, findKey: failing })).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});

describe("createJwksKeyFinder", () => {
  it("fetches the key set once, caches it, and refetches for an unknown key id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ keys: [{ kty: "EC", kid: "ec" }, jwk] }), { status: 200, headers: { etag: "e1" } }));
    const find = createJwksKeyFinder("https://jwks.test/jwks", fetchImpl as unknown as typeof fetch);
    expect((await find("webhook-signing-key-1"))?.kid).toBe("webhook-signing-key-1");
    expect((await find("webhook-signing-key-1"))?.kid).toBe("webhook-signing-key-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await find("rotated-key")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("only returns RSA keys", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ keys: [{ kty: "EC", kid: "ec" }] }), { status: 200 }));
    const find = createJwksKeyFinder("https://jwks.test/jwks", fetchImpl as unknown as typeof fetch);
    expect(await find("ec")).toBeNull();
  });

  it("keeps the cached set on a 304", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { etag: "e1" } })
        : new Response(null, { status: 304 });
    });
    const find = createJwksKeyFinder("https://jwks.test/jwks", fetchImpl as unknown as typeof fetch);
    await find("webhook-signing-key-1");
    expect(await find("unknown")).toBeNull();
    expect((await find("webhook-signing-key-1"))?.kid).toBe("webhook-signing-key-1");
  });
});

describe("tokenMatches", () => {
  it("compares in constant time and refuses empty or different tokens", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
    expect(tokenMatches("abc123", "abc124")).toBe(false);
    expect(tokenMatches("abc", "abc123")).toBe(false);
    expect(tokenMatches(null, "abc")).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
});
