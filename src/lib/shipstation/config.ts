/**
 * ShipStation API (V2) settings from the environment.
 *
 * CDS uses the ShipStation app account with the V2 API: base URL https://api.shipstation.com/v2,
 * authenticated with the API-Key header.
 * Carriers and services are data (public.shipping_carriers and public.shipping_services), never
 * code: UPS by Worldwide Express is added later as one more carrier row.
 */

export const SHIPSTATION_API_BASE = "https://api.shipstation.com/v2";

/**
 * Public keys that sign outgoing webhooks (RSA-SHA256), as a JSON Web Key Set:
 * https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks
 */
export const SHIPSTATION_JWKS_URL = "https://api.shipengine.com/jwks";

export type ShipStationConfig = {
  apiKey: string;
  /** true: every label is created with test_label (no charge, not shippable). */
  testLabels: boolean;
  /**
   * Optional second check on the webhook: when set, the webhook must carry this value in the
   * x-cds-webhook-token header (ShipStation webhooks can send custom headers).
   */
  webhookToken: string | null;
};

const OFF = new Set(["false", "0", "no", "off"]);

/** The ShipStation settings, or null when the API key is missing (the app then shows "not configured"). */
export function shipStationConfig(env: Record<string, string | undefined> = process.env): ShipStationConfig | null {
  const apiKey = env.SHIPSTATION_API_KEY?.trim();
  if (!apiKey) return null;
  const test = env.SHIPSTATION_TEST_LABELS?.trim().toLowerCase();
  return {
    apiKey,
    testLabels: !(test && OFF.has(test)),
    webhookToken: env.SHIPSTATION_WEBHOOK_TOKEN?.trim() || null,
  };
}

export function requireShipStationConfig(): ShipStationConfig {
  const config = shipStationConfig();
  if (!config) throw new Error("ShipStation is not configured: set SHIPSTATION_API_KEY.");
  return config;
}
