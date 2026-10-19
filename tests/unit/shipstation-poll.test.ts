/**
 * Tracking by polling: GET /v2/labels/{label_id}/track per active label, sequential, with
 * backoff on HTTP 429, results through the same status mapping as the webhook, one
 * integration_sync row per run, and the cron route only for Vercel's cron secret.
 */
import { describe, expect, it, vi } from "vitest";
import { ShipStationError, shipStationRequest } from "@/lib/shipstation/client";
import { cronAuthorized, pollTracking, type PollDeps, type TrackResult } from "@/lib/shipstation/poll";
import { parseTrackResponse } from "@/lib/shipstation/tracking";

// GET /v2/labels/{label_id}/track as documented (https://docs.shipstation.com/tracking).
const DELIVERED = {
  tracking_number: "794600000001",
  status_code: "DE",
  status_description: "Delivered",
  carrier_status_code: "DL",
  carrier_status_description: "Delivered",
  shipped_date: "2026-10-20T15:00:00Z",
  estimated_delivery_date: "2026-10-22T00:00:00Z",
  actual_delivery_date: "2026-10-22T17:15:00Z",
  exception_description: null,
  events: [
    {
      occurred_at: "2026-10-22T17:15:00Z",
      carrier_occurred_at: "2026-10-22T10:15:00",
      description: "Delivered",
      city_locality: "Reno",
      state_province: "NV",
      postal_code: "89502",
      country_code: "US",
      company_name: null,
      signer: "J SMITH",
      event_code: "DL",
    },
  ],
};

describe("parseTrackResponse", () => {
  it("reads status, dates and events like the webhook does", () => {
    expect(parseTrackResponse(DELIVERED)).toEqual({
      statusCode: "DE",
      status: "delivered",
      description: "Delivered",
      estimatedDelivery: "2026-10-22T00:00:00Z",
      actualDelivery: "2026-10-22T17:15:00Z",
      events: [{ occurredAt: "2026-10-22T17:15:00Z", carrierCode: "DL", description: "Delivered", location: "Reno, NV 89502, US" }],
    });
  });

  it("maps out for delivery and unknown codes the same way as the webhook", () => {
    expect(parseTrackResponse({ status_code: "IT", carrier_status_description: "Out for delivery" }).status).toBe("out_for_delivery");
    expect(parseTrackResponse({ status_code: "UN" }).status).toBeNull();
    expect(parseTrackResponse(null).status).toBeNull();
  });
});

describe("cronAuthorized", () => {
  it("accepts only Vercel's 'Bearer <CRON_SECRET>' header, and nothing while the secret is not set", () => {
    const secret = "s".repeat(32);
    expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(cronAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(cronAuthorized(secret, secret)).toBe(false);
    expect(cronAuthorized(null, secret)).toBe(false);
    expect(cronAuthorized("Bearer ", "")).toBe(false);
    expect(cronAuthorized("Bearer undefined", undefined)).toBe(false);
  });
});

describe("shipStationRequest", () => {
  it("keeps the Retry-After seconds of a 429", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "7" } }));
    const error = (await shipStationRequest("k", "GET", "labels/se-1/track", { fetchImpl }).catch((e) => e)) as ShipStationError;
    expect(error).toBeInstanceOf(ShipStationError);
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(7);
  });
});

type Recorded = { labelId: string; result: TrackResult };

function deps(over: Partial<PollDeps> & { responses?: Record<string, (() => unknown)[]> } = {}) {
  const recorded: Recorded[] = [];
  const runs: unknown[] = [];
  const slept: number[] = [];
  const calls: string[] = [];
  const responses = over.responses ?? {};
  let clock = 0;
  const d: PollDeps = {
    listLabels: async () => [
      { label_id: "l1", shipstation_label_id: "se-1", tracking_number: "T1", carrier: "FedEx" },
      { label_id: "l2", shipstation_label_id: "se-2", tracking_number: "T2", carrier: "FedEx" },
    ],
    track: async (id) => {
      calls.push(id);
      const queue = responses[id];
      const next = queue?.shift();
      if (!next) return DELIVERED;
      return next();
    },
    record: async (labelId, result) => {
      recorded.push({ labelId, result });
      return "error" in result ? "error" : "applied";
    },
    sweep: async () => 0,
    recordRun: async (run) => {
      runs.push(run);
    },
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { d, recorded, runs, slept, calls };
}

describe("pollTracking", () => {
  it("tracks each label once, in order, spaced out, and records one run", async () => {
    const { d, recorded, runs, calls, slept } = deps();
    const summary = await pollTracking(d, { spacingMs: 300 });
    expect(calls).toEqual(["se-1", "se-2"]);
    expect(recorded.map((r) => r.labelId)).toEqual(["l1", "l2"]);
    expect(recorded[0].result).toMatchObject({ statusCode: "DE", status: "delivered", actualDelivery: "2026-10-22T17:15:00Z" });
    expect(slept).toEqual([300]);
    expect(summary).toMatchObject({ checked: 2, applied: 2, failed: 0, delivered: 0, stopped: null });
    expect(runs).toEqual([summary]);
  });

  it("waits Retry-After on a 429 and tries the same label again", async () => {
    const { d, calls, recorded, slept } = deps({
      responses: { "se-1": [() => Promise.reject(new ShipStationError("busy", 429, undefined, 5))] },
    });
    const summary = await pollTracking(d, { spacingMs: 0 });
    expect(calls).toEqual(["se-1", "se-1", "se-2"]);
    expect(slept).toContain(5000);
    expect(recorded.map((r) => r.labelId)).toEqual(["l1", "l2"]);
    expect(summary).toMatchObject({ checked: 2, failed: 0, stopped: null });
  });

  it("stops the run when ShipStation keeps answering 429, leaving the rest for the next run", async () => {
    const busy = () => Promise.reject(new ShipStationError("busy", 429, undefined, 1));
    const { d, calls, recorded } = deps({ responses: { "se-1": [busy, busy, busy, busy] } });
    const summary = await pollTracking(d, { spacingMs: 0, maxRetries: 2 });
    expect(calls).toEqual(["se-1", "se-1", "se-1"]);
    expect(recorded).toEqual([]);
    expect(summary.stopped).toMatch(/rate limit/);
  });

  it("records a failed label and goes on with the next one", async () => {
    const { d, recorded } = deps({
      responses: { "se-1": [() => Promise.reject(new ShipStationError("Label not found", 404))] },
    });
    const summary = await pollTracking(d, { spacingMs: 0 });
    expect(recorded[0]).toEqual({ labelId: "l1", result: { error: "Label not found" } });
    expect(recorded[1].labelId).toBe("l2");
    expect(summary).toMatchObject({ checked: 2, failed: 1 });
  });

  it("stops at once when the API key is refused", async () => {
    const { d, calls, runs } = deps({
      responses: { "se-1": [() => Promise.reject(new ShipStationError("refused", 401))] },
    });
    const summary = await pollTracking(d, { spacingMs: 0 });
    expect(calls).toEqual(["se-1"]);
    expect(summary.stopped).toMatch(/refused/);
    expect(runs).toHaveLength(1);
  });

  it("stops before the time budget runs out", async () => {
    const { d, calls } = deps();
    const summary = await pollTracking(d, { spacingMs: 1000, budgetMs: 500 });
    expect(calls).toEqual(["se-1"]);
    expect(summary.stopped).toMatch(/time/);
  });

  it("runs the Delivered sweep and counts what it moved", async () => {
    const { d } = deps({ sweep: async () => 2 });
    expect((await pollTracking(d, { spacingMs: 0 })).delivered).toBe(2);
  });
});
