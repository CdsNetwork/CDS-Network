import { describe, expect, it } from "vitest";
import { mapTrackStatus, parseTrackWebhook } from "@/lib/shipstation/tracking";

describe("mapTrackStatus", () => {
  it.each([
    ["NY", undefined, "awaiting_pickup"],
    ["AC", undefined, "picked_up"],
    ["IT", undefined, "in_transit"],
    ["DE", undefined, "delivered"],
    ["SP", undefined, "delivered"],
    ["AT", undefined, "delayed"],
    ["EX", undefined, "exception"],
  ])("%s maps to %s", (code, detail, expected) => {
    expect(mapTrackStatus({ statusCode: code, statusDetailCode: detail })).toBe(expected);
  });

  it("an in-transit event that is out for delivery shows Out for Delivery", () => {
    expect(mapTrackStatus({ statusCode: "IT", statusDetailCode: "OUT_FOR_DELIVERY" })).toBe("out_for_delivery");
    expect(mapTrackStatus({ statusCode: "IT", description: "On FedEx vehicle for delivery, Out For Delivery" })).toBe(
      "out_for_delivery",
    );
  });

  it("an exception about the address shows Address Problem", () => {
    expect(mapTrackStatus({ statusCode: "EX", statusDetailCode: "ADDRESS_NOT_FOUND" })).toBe("address_problem");
    expect(mapTrackStatus({ statusCode: "EX", description: "Incorrect address" })).toBe("address_problem");
  });

  it("unknown or missing codes change nothing", () => {
    expect(mapTrackStatus({ statusCode: "UN" })).toBeNull();
    expect(mapTrackStatus({ statusCode: "" })).toBeNull();
    expect(mapTrackStatus({ statusCode: "ZZ" })).toBeNull();
  });

  it("is case insensitive", () => {
    expect(mapTrackStatus({ statusCode: "de" })).toBe("delivered");
  });
});

// The API_TRACK body as documented
// (https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks), trimmed.
const TRACK = {
  resource_url: "https://api.shipengine.com/v1/tracking?carrier_code=fedex&tracking_number=794600000001",
  resource_type: "API_TRACK",
  data: {
    label_url: null,
    tracking_number: "794600000001",
    status_code: "IT",
    status_description: "In Transit",
    carrier_status_code: "IT",
    carrier_status_description: "On the way",
    ship_date: "2026-10-19T00:00:00Z",
    estimated_delivery_date: "2026-10-22T00:00:00Z",
    actual_delivery_date: null,
    exception_description: null,
    events: [
      {
        occurred_at: "2026-10-19T14:02:00Z",
        carrier_occurred_at: "2026-10-19T07:02:00",
        description: "Picked up",
        city_locality: "Phoenix",
        state_province: "AZ",
        postal_code: "85043",
        country_code: "US",
        event_code: "PU",
        status_code: "AC",
      },
      {
        occurred_at: "2026-10-20T03:40:00Z",
        description: "Departed FedEx location",
        city_locality: "Albuquerque",
        state_province: "NM",
        country_code: "US",
        event_code: "DP",
        status_code: "IT",
      },
    ],
  },
};

describe("parseTrackWebhook", () => {
  it("reads the tracking number, the mapped status, the ETA and the events", () => {
    const parsed = parseTrackWebhook(TRACK);
    expect(parsed).toEqual({
      kind: "track",
      trackingNumber: "794600000001",
      carrierCode: "fedex",
      statusCode: "IT",
      status: "in_transit",
      description: "In Transit",
      estimatedDelivery: "2026-10-22T00:00:00Z",
      actualDelivery: null,
      events: [
        {
          occurredAt: "2026-10-19T14:02:00Z",
          carrierCode: "PU",
          description: "Picked up",
          location: "Phoenix, AZ 85043, US",
        },
        {
          occurredAt: "2026-10-20T03:40:00Z",
          carrierCode: "DP",
          description: "Departed FedEx location",
          location: "Albuquerque, NM, US",
        },
      ],
    });
  });

  it("ignores other webhook kinds", () => {
    expect(parseTrackWebhook({ resource_type: "API_BATCH", resource_url: "x" })).toEqual({ kind: "ignored", resourceType: "API_BATCH" });
  });

  it("refuses a track event without a tracking number", () => {
    expect(parseTrackWebhook({ resource_type: "API_TRACK", data: { status_code: "IT" } })).toEqual({
      kind: "invalid",
      reason: "no tracking number",
    });
    expect(parseTrackWebhook("nope")).toEqual({ kind: "invalid", reason: "not an object" });
  });

  it("caps the number of events and the length of texts", () => {
    const many = {
      ...TRACK,
      data: {
        ...TRACK.data,
        events: Array.from({ length: 400 }, (_, i) => ({ occurred_at: `2026-10-19T00:00:${String(i % 60).padStart(2, "0")}Z`, description: "x".repeat(900) })),
      },
    };
    const parsed = parseTrackWebhook(many);
    if (parsed.kind !== "track") throw new Error("expected track");
    expect(parsed.events.length).toBe(200);
    expect(parsed.events[0].description?.length).toBe(500);
  });

  it("reads the carrier code from the resource URL only when it is a known code", () => {
    const parsed = parseTrackWebhook({ ...TRACK, resource_url: "not a url" });
    expect(parsed.kind === "track" && parsed.carrierCode).toBeNull();
  });
});
