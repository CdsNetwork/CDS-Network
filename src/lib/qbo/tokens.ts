import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { qboConfig, type QboConfig, type QboEnvironment } from "./config";
import { QboError, refreshTokens, revokeToken, type QboApi, type TokenResponse } from "./client";
import { decryptToken, encryptToken } from "./secure";

/**
 * The QuickBooks connection and its tokens. Tokens are read and written with the service
 * role only, through functions no login can call (migration 20261016000000). Call these
 * only after requireCds().
 */

type StoredConnection = {
  environment: QboEnvironment;
  realm_id: string;
  company_name: string | null;
  ast_enabled: boolean | null;
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string | null;
};

/** Refresh a little before the access token (about 1 hour) runs out. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function expiresAt(seconds: number | undefined): string | null {
  return seconds === undefined || !Number.isFinite(seconds) ? null : new Date(Date.now() + seconds * 1000).toISOString();
}

async function load(): Promise<StoredConnection | null> {
  const { data, error } = await createAdminClient().rpc("qbo_get_connection");
  if (error) throw new Error(`Could not read the QuickBooks connection: ${error.message}`);
  return (data as StoredConnection | null) ?? null;
}

export async function saveConnection(input: {
  config: QboConfig;
  realmId: string;
  companyName: string | null;
  astEnabled: boolean | null;
  tokens: TokenResponse;
  connectedBy: string;
}): Promise<void> {
  const { config, tokens } = input;
  const { error } = await createAdminClient().rpc("qbo_save_connection", {
    p_environment: config.environment,
    p_realm_id: input.realmId,
    p_company_name: input.companyName,
    p_ast_enabled: input.astEnabled,
    p_access_token: encryptToken(config.clientSecret, tokens.access_token),
    p_access_token_expires_at: expiresAt(tokens.expires_in),
    p_refresh_token: encryptToken(config.clientSecret, tokens.refresh_token),
    p_refresh_token_expires_at: expiresAt(tokens.x_refresh_token_expires_in),
    p_connected_by: input.connectedBy,
  });
  if (error) throw new Error(`Could not save the QuickBooks connection: ${error.message}`);
}

/**
 * API access for the connected company, refreshing the access token when it is about to
 * expire. Throws a QboError the user can act on when QuickBooks is not connected, the
 * connection is for the other environment, or the connection has expired.
 */
export async function qboApi(options: { forceRefresh?: boolean } = {}): Promise<QboApi & { astEnabled: boolean | null }> {
  const config = qboConfig();
  if (!config) throw new QboError("QuickBooks is not configured on this server.", 0, "Config");
  const stored = await load();
  if (!stored) throw new QboError("QuickBooks is not connected. Connect it in Admin > Settings.", 0, "Config");
  if (stored.environment !== config.environment) {
    throw new QboError(
      `QuickBooks is connected to the ${stored.environment} company, but this server uses ${config.environment}. Connect again in Admin > Settings.`,
      0,
      "Config",
    );
  }

  let access: string;
  try {
    access = decryptToken(config.clientSecret, stored.access_token);
  } catch {
    throw new QboError("The stored QuickBooks connection cannot be read. Connect QuickBooks again in Admin > Settings.", 0, "Config");
  }
  const fresh = Date.parse(stored.access_token_expires_at) - Date.now() > REFRESH_MARGIN_MS;
  if (fresh && !options.forceRefresh) {
    return { environment: stored.environment, realmId: stored.realm_id, accessToken: access, astEnabled: stored.ast_enabled };
  }

  const refreshToken = decryptToken(config.clientSecret, stored.refresh_token);
  let tokens: TokenResponse;
  try {
    tokens = await refreshTokens(config, refreshToken);
  } catch (e) {
    // Another request may have refreshed (and rotated the refresh token) at the same time.
    const again = await load();
    if (again && again.refresh_token !== stored.refresh_token && Date.parse(again.access_token_expires_at) > Date.now()) {
      return {
        environment: again.environment,
        realmId: again.realm_id,
        accessToken: decryptToken(config.clientSecret, again.access_token),
        astEnabled: again.ast_enabled,
      };
    }
    if (e instanceof QboError && e.code === "invalid_grant") {
      throw new QboError("The QuickBooks connection has expired or was revoked. Connect QuickBooks again in Admin > Settings.", 401, "OAuth");
    }
    throw e;
  }

  const { data: saved, error } = await createAdminClient().rpc("qbo_save_tokens", {
    p_realm_id: stored.realm_id,
    p_previous_refresh_token: stored.refresh_token,
    p_access_token: encryptToken(config.clientSecret, tokens.access_token),
    p_access_token_expires_at: expiresAt(tokens.expires_in),
    p_refresh_token: encryptToken(config.clientSecret, tokens.refresh_token),
    p_refresh_token_expires_at: expiresAt(tokens.x_refresh_token_expires_in),
  });
  if (error) throw new Error(`Could not save the refreshed QuickBooks token: ${error.message}`);
  // saved is false when another request stored newer tokens first; ours still work for now.
  void saved;
  return { environment: stored.environment, realmId: stored.realm_id, accessToken: tokens.access_token, astEnabled: stored.ast_enabled };
}

/** Revokes the app's access at Intuit (best effort) and forgets the connection. */
export async function disconnect(actorId: string): Promise<{ revoked: boolean }> {
  const config = qboConfig();
  const stored = await load();
  let revoked = false;
  if (stored && config) {
    try {
      await revokeToken(config, decryptToken(config.clientSecret, stored.refresh_token));
      revoked = true;
    } catch {
      // The connection is forgotten anyway; access can also be removed in QuickBooks.
    }
  }
  const { error } = await createAdminClient().rpc("qbo_delete_connection", { p_actor: actorId });
  if (error) throw new Error(`Could not remove the QuickBooks connection: ${error.message}`);
  return { revoked };
}
