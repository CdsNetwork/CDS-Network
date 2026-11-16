import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reserves a label purchase (kind "label", target = the shipment) or a pickup booking (kind
 * "pickup", target = the label) before ShipStation is called, so two requests at the same
 * time buy only one (public.cds_claim_shipstation, 20261116030000_shipstation_claims.sql).
 * The claim is released after the result is recorded or ShipStation clearly refused; a claim
 * that is never released expires after 5 minutes.
 */

export type ClaimKind = "label" | "pickup";

export async function claimShipStation(
  db: SupabaseClient,
  kind: ClaimKind,
  target: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data, error } = await db.rpc("cds_claim_shipstation", { p_kind: kind, p_target: target });
  if (error) {
    // Raised by the function: written for users.
    if (error.code === "P0001" || error.code === "P0002") return { ok: false, error: error.message };
    return { ok: false, error: "The shipment could not be reserved. Try again." };
  }
  if (typeof data !== "string" || !data) return { ok: false, error: "The shipment could not be reserved. Try again." };
  return { ok: true, id: data };
}

/** Drops the claim. A failure is ignored: the claim then expires by itself. */
export async function releaseShipStation(db: SupabaseClient, kind: ClaimKind, target: string, id: string): Promise<void> {
  try {
    await db.rpc("cds_release_shipstation", { p_kind: kind, p_target: target, p_claim: id });
  } catch {
    // Expires after 5 minutes.
  }
}
