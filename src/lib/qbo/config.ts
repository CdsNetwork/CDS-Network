/**
 * QuickBooks Online settings from the environment.
 *
 * Endpoints are from Intuit's OpenID discovery documents
 * (https://developer.api.intuit.com/.well-known/openid_configuration and
 * .../openid_sandbox_configuration): the authorize, token and revoke endpoints are the same
 * for sandbox and production; only the API base URL differs.
 * API base URLs: https://developer.intuit.com/app/developer/qbo/docs/develop/explore-the-quickbooks-online-api
 */

export type QboEnvironment = "sandbox" | "production";

export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

/**
 * Intuit retired minor versions 1 to 74 on 2025-08-01: lower values are ignored and 75 is
 * the default (Intuit developer blog announcement, see also
 * https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions).
 */
export const QBO_MINOR_VERSION = "75";

export const QBO_API_BASE: Record<QboEnvironment, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};

export type QboConfig = {
  clientId: string;
  clientSecret: string;
  environment: QboEnvironment;
  redirectUri: string;
};

/** The QuickBooks settings, or null when any is missing (the app then shows "not configured"). */
export function qboConfig(env: Record<string, string | undefined> = process.env): QboConfig | null {
  const clientId = env.QBO_CLIENT_ID?.trim();
  const clientSecret = env.QBO_CLIENT_SECRET?.trim();
  const redirectUri = env.QBO_REDIRECT_URI?.trim();
  const environment = env.QBO_ENVIRONMENT?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  if (environment !== "sandbox" && environment !== "production") return null;
  return { clientId, clientSecret, environment, redirectUri };
}

export function requireQboConfig(): QboConfig {
  const config = qboConfig();
  if (!config) {
    throw new Error(
      "QuickBooks is not configured: set QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT (sandbox or production) and QBO_REDIRECT_URI.",
    );
  }
  return config;
}
