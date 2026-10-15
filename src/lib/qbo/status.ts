import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { qboConfig, type QboEnvironment } from "./config";

export type QboStatus = {
  /** The server has the Intuit app settings. */
  configured: boolean;
  /** The environment this server uses (QBO_ENVIRONMENT). */
  serverEnvironment: QboEnvironment | null;
  /** Connected to a company in the environment this server uses. */
  connected: boolean;
  environment: QboEnvironment | null;
  companyName: string | null;
  astEnabled: boolean | null;
  connectedAt: string | null;
  connectedByName: string | null;
  error: string | null;
};

/** Whether QuickBooks is connected, read as the signed-in CDS user (no tokens). */
export async function qboStatus(supabase: Awaited<ReturnType<typeof createClient>>): Promise<QboStatus> {
  const config = qboConfig();
  const { data, error } = await supabase.rpc("qbo_connection_status");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        connected: boolean;
        environment: QboEnvironment;
        company_name: string | null;
        ast_enabled: boolean | null;
        connected_at: string;
        connected_by_name: string | null;
      }
    | null
    | undefined;
  const environment = row?.environment ?? null;
  return {
    configured: config !== null,
    serverEnvironment: config?.environment ?? null,
    connected: !!row?.connected && config !== null && environment === config.environment,
    environment,
    companyName: row?.company_name ?? null,
    astEnabled: row?.ast_enabled ?? null,
    connectedAt: row?.connected_at ?? null,
    connectedByName: row?.connected_by_name ?? null,
    error: error ? "Could not read the QuickBooks connection." : null,
  };
}
