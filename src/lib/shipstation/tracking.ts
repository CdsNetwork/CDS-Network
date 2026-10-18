/**
 * Tracking webhooks (event "track", resource_type API_TRACK) and how a carrier status maps
 * to the portal's shipment status. Pure functions.
 *
 * Payload: https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks
 * status_code values: UN unknown, NY not yet in system, AC accepted (picked up),
 * IT in transit, DE delivered, SP delivered to a collection point, AT delivery attempt,
 * EX exception.
 */

export type ShipmentStatus =
  | "label_created"
  | "awaiting_pickup"
  | "picked_up"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "delayed"
  | "exception"
  | "address_problem"
  | "no_scan";

/** The shipment status for a tracking status, or null to leave the status as it is. */
export function mapTrackStatus(input: { statusCode?: string | null; statusDetailCode?: string | null; description?: string | null }): ShipmentStatus | null {
  const code = (input.statusCode ?? "").trim().toUpperCase();
  const detail = (input.statusDetailCode ?? "").trim().toUpperCase();
  const text = (input.description ?? "").toLowerCase();
  switch (code) {
    case "NY":
      return "awaiting_pickup";
    case "AC":
      return "picked_up";
    case "IT":
      return detail === "OUT_FOR_DELIVERY" || text.includes("out for delivery") ? "out_for_delivery" : "in_transit";
    case "DE":
    case "SP":
      return "delivered";
    case "AT":
      return "delayed";
    case "EX":
      return detail.includes("ADDRESS") || text.includes("address") ? "address_problem" : "exception";
    default:
      return null;
  }
}

export type TrackEvent = {
  occurredAt: string | null;
  carrierCode: string | null;
  description: string | null;
  location: string | null;
};

export type ParsedWebhook =
  | {
      kind: "track";
      trackingNumber: string;
      carrierCode: string | null;
      statusCode: string | null;
      status: ShipmentStatus | null;
      description: string | null;
      estimatedDelivery: string | null;
      actualDelivery: string | null;
      events: TrackEvent[];
    }
  | { kind: "ignored"; resourceType: string }
  | { kind: "invalid"; reason: string };

const MAX_EVENTS = 200;
const MAX_TEXT = 500;

function str(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function carrierFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const code = new URL(url).searchParams.get("carrier_code");
    return code && /^[a-z0-9_]{2,40}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

type RawEvent = Record<string, unknown>;

export function parseTrackWebhook(body: unknown): ParsedWebhook {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "invalid", reason: "not an object" };
  const b = body as { resource_type?: unknown; resource_url?: unknown; data?: Record<string, unknown> };
  const type = typeof b.resource_type === "string" ? b.resource_type : "";
  if (type !== "API_TRACK") return { kind: "ignored", resourceType: type || "unknown" };
  const d = b.data && typeof b.data === "object" ? b.data : {};
  const trackingNumber = str(d.tracking_number, 100);
  if (!trackingNumber) return { kind: "invalid", reason: "no tracking number" };

  const rawEvents = Array.isArray(d.events) ? (d.events as RawEvent[]) : [];
  const events: TrackEvent[] = rawEvents.slice(0, MAX_EVENTS).map((e) => {
    const city = str(e.city_locality, 100);
    const state = str(e.state_province, 50);
    const zip = str(e.postal_code, 20);
    const country = str(e.country_code, 10);
    const cityState = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const location = [cityState, country].filter(Boolean).join(", ");
    return {
      occurredAt: str(e.occurred_at, 40),
      carrierCode: str(e.event_code, 40),
      description: str(e.description),
      location: location || null,
    };
  });

  const statusCode = str(d.status_code, 10);
  const description = str(d.status_description);
  return {
    kind: "track",
    trackingNumber,
    carrierCode: carrierFromUrl(b.resource_url),
    statusCode,
    status: mapTrackStatus({
      statusCode,
      statusDetailCode: str(d.status_detail_code, 60),
      description: [description, str(d.carrier_status_description)].filter(Boolean).join(" "),
    }),
    description,
    estimatedDelivery: str(d.estimated_delivery_date, 40),
    actualDelivery: str(d.actual_delivery_date, 40),
    events,
  };
}
