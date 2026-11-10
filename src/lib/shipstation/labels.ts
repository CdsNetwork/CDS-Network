import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordSync } from "@/lib/integration-sync";
import { shipStationRequest, ShipStationError } from "./client";
import { shipStationConfig } from "./config";
import { ENDS, labelShop, NO_LOCATION_PROBLEM, NO_SHOP_PROBLEM } from "./ends";
import { packageForShipment, type ShipmentPackage } from "./package";
import {
  buildLabelRequest,
  buildRatesRequest,
  mapLabel,
  mapRates,
  ratesFailureMessage,
  toShipAddress,
  type PortalAddress,
  type Rate,
  type ShipAddress,
} from "./requests";

/**
 * Rates, labels and voids for one shipment leg. Callers check requireCds() first and pass
 * the signed-in user's client: every read goes through RLS and the label is recorded by
 * public.cds_record_shipment_label. Only the label PDF is stored with the service role
 * (the wo-files bucket is written that way everywhere in the app).
 */

type Db = SupabaseClient;

type One<T> = T | T[] | null;
const one = <T,>(v: One<T> | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

type LocationRow = {
  name: string;
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
};
type ShopRow = {
  display_name: string;
  active: boolean;
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
};
type SettingsRow = {
  from_name: string | null;
  from_company: string | null;
  from_phone: string | null;
  from_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  default_weight_lb: number | string;
  default_length_in: number | string | null;
  default_width_in: number | string | null;
  default_height_in: number | string | null;
};
type CarrierRow = {
  shipstation_carrier_id: string;
  carrier: string;
  name: string;
  active: boolean;
  shipping_services: { service_code: string; name: string; active: boolean }[] | null;
};

type Context = {
  shipmentId: string;
  workOrderId: string;
  woNumber: number;
  direction: string;
  pkg: ShipmentPackage;
  from: { address: ShipAddress; summary: string };
  to: { address: ShipAddress; summary: string };
  carriers: CarrierRow[];
  hasActiveLabel: boolean;
  /** The shop at the leg's shop end (null for legs between CDS and the customer). */
  shopId: string | null;
};

function summary(a: ShipAddress): string {
  return [a.company_name ?? a.name, a.address_line1, `${a.city_locality} ${a.state_province} ${a.postal_code}`].join(", ");
}

async function loadContext(db: Db, shipmentId: string): Promise<{ ok: true; ctx: Context } | { ok: false; error: string }> {
  const { data: sh, error } = await db
    .from("shipments")
    .select(
      "id, work_order_id, direction, weight_lb, length_in, width_in, height_in, work_orders(id, wo_number, status, location_label, location_id, affiliate_id, customers(name), customer_locations(default_affiliate_id))",
    )
    .eq("id", shipmentId)
    .maybeSingle();
  if (error) return { ok: false, error: "The shipment could not be read. Try again." };
  if (!sh) return { ok: false, error: "Shipment not found." };
  const wo = one(
    sh.work_orders as One<{
      id: string;
      wo_number: number;
      status: string;
      location_label: string;
      location_id: string | null;
      affiliate_id: string | null;
      customers: One<{ name: string }>;
      customer_locations: One<{ default_affiliate_id: string | null }>;
    }>,
  );
  if (!wo) return { ok: false, error: "Work order not found." };
  const ends = ENDS[sh.direction];
  if (!ends) return { ok: false, error: "This shipment direction has no label." };
  // The order's shop, or while it is in review the planned shop (CDS preps labels before dispatch).
  const shopFor = ends.includes("shop")
    ? labelShop({ status: wo.status, affiliateId: wo.affiliate_id, locationDefault: one(wo.customer_locations)?.default_affiliate_id ?? null })
    : null;

  const [loc, shop, settings, carriers, active] = await Promise.all([
    wo.location_id
      ? db.from("customer_locations").select("name, address_line1, city, region, postal_code, country").eq("id", wo.location_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    shopFor
      ? db.from("affiliates").select("display_name, active, address_line1, city, region, postal_code, country").eq("id", shopFor.affiliateId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db
      .from("shipping_settings")
      .select(
        "from_name, from_company, from_phone, from_email, address_line1, address_line2, city, region, postal_code, country, default_weight_lb, default_length_in, default_width_in, default_height_in",
      )
      .maybeSingle(),
    db
      .from("shipping_carriers")
      .select("shipstation_carrier_id, carrier, name, active, shipping_services(service_code, name, active)")
      .eq("active", true)
      .order("sort_order"),
    db.from("shipment_labels").select("id", { count: "exact", head: true }).eq("shipment_id", shipmentId).eq("status", "active"),
  ]);
  if (loc.error || shop.error || settings.error || carriers.error || active.error) {
    return { ok: false, error: "The shipping details could not be read. Try again." };
  }
  const s = settings.data as SettingsRow | null;
  const cdsPhone = s?.from_phone ?? null;
  const customer = one(wo.customers)?.name ?? null;

  const party = (end: "location" | "shop" | "cds"): { ok: true; address: ShipAddress } | { ok: false; problem: string } => {
    if (end === "location") {
      const l = loc.data as LocationRow | null;
      if (!l) return { ok: false, problem: NO_LOCATION_PROBLEM };
      const input: PortalAddress = {
        name: "Receiving",
        company: [customer, l.name].filter(Boolean).join(" ") || wo.location_label,
        phone: cdsPhone,
        line1: l.address_line1,
        city: l.city,
        region: l.region,
        postalCode: l.postal_code,
        country: l.country,
      };
      return toShipAddress(input, "Customer location");
    }
    if (end === "shop") {
      const a = shop.data as ShopRow | null;
      // A planned shop must still be one Review & Dispatch offers (active).
      if (!a || (shopFor?.planned && !a.active)) return { ok: false, problem: NO_SHOP_PROBLEM };
      return toShipAddress(
        { name: "Service Department", company: a.display_name, phone: cdsPhone, line1: a.address_line1, city: a.city, region: a.region, postalCode: a.postal_code, country: a.country },
        "Shop",
      );
    }
    return toShipAddress(
      {
        name: s?.from_name,
        company: s?.from_company,
        phone: s?.from_phone,
        email: s?.from_email,
        line1: s?.address_line1,
        line2: s?.address_line2,
        city: s?.city,
        region: s?.region,
        postalCode: s?.postal_code,
        country: s?.country,
      },
      "CDS (Shipping settings)",
    );
  };

  const from = party(ends[0]);
  const to = party(ends[1]);
  const problems = [from, to].filter((p): p is { ok: false; problem: string } => !p.ok).map((p) => p.problem);
  if (problems.length) {
    const phoneHint = problems.some((p) => p.includes("phone")) && !cdsPhone ? " Add CDS's phone under Shipping settings (used for locations and shops)." : "";
    return { ok: false, error: `${problems.join(". ")}.${phoneHint}` };
  }
  if (!from.ok || !to.ok) return { ok: false, error: "Address problem." };

  // The package saved on the shipment (from the rates box or the Shipping form), else the default.
  const pkg: ShipmentPackage = packageForShipment(sh, s);

  return {
    ok: true,
    ctx: {
      shipmentId,
      workOrderId: wo.id,
      woNumber: wo.wo_number,
      direction: sh.direction,
      pkg,
      from: { address: from.address, summary: summary(from.address) },
      to: { address: to.address, summary: summary(to.address) },
      carriers: (carriers.data ?? []) as CarrierRow[],
      hasActiveLabel: (active.count ?? 0) > 0,
      shopId: shopFor?.affiliateId ?? null,
    },
  };
}

/** Allowed services per carrier: active service rows, or all services when a carrier has none. */
function allowedServices(carriers: CarrierRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of carriers) {
    const rows = c.shipping_services ?? [];
    const active = rows.filter((r) => r.active).map((r) => r.service_code);
    // A carrier whose service rows are all off offers nothing.
    out[c.shipstation_carrier_id] = rows.length && !active.length ? ["__none__"] : active;
  }
  return out;
}

function failure(e: unknown): string {
  if (e instanceof ShipStationError) return e.message;
  return e instanceof Error ? e.message : "Unknown error";
}

async function logSync(db: Db, entity: string, shipmentId: string, status: string, externalId: string | null, error: string | null) {
  await recordSync(db, {
    system: "shipstation",
    entity,
    entity_id: shipmentId,
    external_id: externalId,
    direction: "push",
    status,
    error: error ? error.slice(0, 2000) : null,
  });
}

export type RatesResult =
  | { ok: true; rates: (Rate & { carrierName: string })[]; problems: string[]; testLabels: boolean; from: string; to: string; pkg: ShipmentPackage }
  | { ok: false; error: string };

export async function ratesForShipment(db: Db, shipmentId: string): Promise<RatesResult> {
  const config = shipStationConfig();
  if (!config) return { ok: false, error: "ShipStation is not configured (SHIPSTATION_API_KEY)." };
  const loaded = await loadContext(db, shipmentId);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  if (!ctx.carriers.length) return { ok: false, error: "No carrier is turned on. Turn one on under Shipping settings." };

  let body;
  try {
    body = buildRatesRequest({ shipFrom: ctx.from.address, shipTo: ctx.to.address, pkg: ctx.pkg, carrierIds: ctx.carriers.map((c) => c.shipstation_carrier_id) });
  } catch (e) {
    return { ok: false, error: failure(e) };
  }
  try {
    const res = await shipStationRequest<unknown>(config.apiKey, "POST", "rates", { body });
    const { rates, problems, upstream } = mapRates(res, allowedServices(ctx.carriers));
    if (upstream.length) console.warn(`ShipStation rates for shipment ${shipmentId}: carrier errors: ${upstream.join(" | ").slice(0, 2000)}`);
    const names = new Map(ctx.carriers.map((c) => [c.shipstation_carrier_id, c.name]));
    return {
      ok: true,
      rates: rates.map((r) => ({ ...r, carrierName: names.get(r.carrierId) ?? r.carrierCode })),
      problems,
      testLabels: config.testLabels,
      from: ctx.from.summary,
      to: ctx.to.summary,
      pkg: ctx.pkg,
    };
  } catch (e) {
    await logSync(db, "rates", shipmentId, "error", null, failure(e));
    if (e instanceof ShipStationError) {
      if (e.status === 0 || e.status >= 500) console.error(`ShipStation rates for shipment ${shipmentId} failed: ${e.message}`);
      return { ok: false, error: ratesFailureMessage(e) };
    }
    console.error(`ShipStation rates for shipment ${shipmentId} failed: ${failure(e)}`);
    return { ok: false, error: ratesFailureMessage({ message: failure(e), status: 0 }) };
  }
}

export type LabelChoice = { carrierId: string; serviceCode: string; rateId: string | null; quotedTotal: number | null; deliveryDays: number | null };

export type LabelResult = { ok: true; message: string } | { ok: false; error: string };

const TEST_HINT =
  " FedEx refuses test labels; UPS (WWEX) and USPS accept them. To try the flow, use UPS (WWEX) or USPS (turn one on under Shipping settings); real labels need SHIPSTATION_TEST_LABELS=false.";

export async function createLabelForShipment(db: Db, shipmentId: string, choice: LabelChoice): Promise<LabelResult> {
  const config = shipStationConfig();
  if (!config) return { ok: false, error: "ShipStation is not configured (SHIPSTATION_API_KEY)." };
  const loaded = await loadContext(db, shipmentId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { ctx } = loaded;
  if (ctx.hasActiveLabel) return { ok: false, error: "This shipment already has a label. Void it before creating another." };

  const carrier = ctx.carriers.find((c) => c.shipstation_carrier_id === choice.carrierId);
  if (!carrier) return { ok: false, error: "That carrier is not turned on." };
  const allowed = allowedServices([carrier])[carrier.shipstation_carrier_id];
  if (allowed.length && !allowed.includes(choice.serviceCode)) return { ok: false, error: "That service is not turned on for this carrier." };
  const serviceName = carrier.shipping_services?.find((s) => s.service_code === choice.serviceCode)?.name ?? null;

  let body;
  try {
    body = buildLabelRequest({
      shipFrom: ctx.from.address,
      shipTo: ctx.to.address,
      pkg: ctx.pkg,
      carrierId: carrier.shipstation_carrier_id,
      serviceCode: choice.serviceCode,
      testLabel: config.testLabels,
      reference: `WO ${ctx.woNumber}`,
      externalShipmentId: `${shipmentId}-${Date.now()}`,
    });
  } catch (e) {
    return { ok: false, error: failure(e) };
  }

  let label;
  try {
    label = mapLabel(await shipStationRequest<unknown>(config.apiKey, "POST", "labels", { body, timeoutMs: 90_000 }), config.testLabels);
  } catch (e) {
    const msg = failure(e);
    await logSync(db, "label", shipmentId, e instanceof ShipStationError && e.rejected ? "rejected" : "error", null, msg);
    const hint = config.testLabels && /test label/i.test(msg) ? TEST_HINT : "";
    if (e instanceof ShipStationError && !e.rejected) {
      return { ok: false, error: `ShipStation did not answer clearly (${msg}). Check ShipStation for a new label before trying again.` };
    }
    return { ok: false, error: `ShipStation refused the label: ${msg}.${hint}` };
  }

  const filePath = await storePdf(ctx.workOrderId, shipmentId, label.labelId, label.pdfUrl, config.apiKey);

  const { error } = await db.rpc("cds_record_shipment_label", {
    p_shipment: shipmentId,
    p_label: {
      shipstation_label_id: label.labelId,
      shipstation_shipment_id: label.shipmentId,
      shipstation_carrier_id: carrier.shipstation_carrier_id,
      service_code: choice.serviceCode,
      service_name: serviceName ?? choice.serviceCode,
      tracking_number: label.trackingNumber,
      tracking_url: label.trackingUrl,
      is_test: label.isTest,
      label_url: label.pdfUrl,
      label_file_path: filePath,
      ship_from_summary: ctx.from.summary,
      ship_to_summary: ctx.to.summary,
      shop_affiliate_id: ctx.shopId,
      rate_id: choice.rateId,
      quoted_total: choice.quotedTotal,
      label_cost: label.cost,
      insurance_cost: label.insurance,
      currency: label.currency,
      delivery_days: choice.deliveryDays,
    },
  });
  if (error) {
    const msg = `Label ${label.labelId} (tracking ${label.trackingNumber ?? "none"}) was created in ShipStation but not saved in the portal: ${error.message}`;
    await logSync(db, "label", shipmentId, "error", label.labelId, msg);
    return { ok: false, error: label.isTest ? msg : `${msg}. Void it in ShipStation if it will not be used.` };
  }
  return {
    ok: true,
    message: label.isTest
      ? `Test label created (not shippable, no charge). Tracking ${label.trackingNumber ?? "none"}.`
      : `Label created. Tracking ${label.trackingNumber ?? "pending"}.`,
  };
}

/** Saves the label PDF in the wo-files bucket. Returns the path, or null (the ShipStation link still works for a while). */
async function storePdf(workOrderId: string, shipmentId: string, labelId: string, url: string | null, apiKey: string): Promise<string | null> {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    const res = await fetch(u, {
      headers: u.hostname === "api.shipstation.com" ? { "API-Key": apiKey } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return null;
    const path = `${workOrderId}/labels/${shipmentId}-${labelId.replace(/[^A-Za-z0-9_-]/g, "")}.pdf`;
    const { error } = await createAdminClient().storage.from("wo-files").upload(path, bytes, { contentType: "application/pdf", upsert: true });
    return error ? null : path;
  } catch {
    return null;
  }
}

export async function voidLabel(db: Db, labelId: string): Promise<LabelResult> {
  const { data: l, error } = await db
    .from("shipment_labels")
    .select("id, shipment_id, shipstation_label_id, is_test, status")
    .eq("id", labelId)
    .maybeSingle();
  if (error) return { ok: false, error: "The label could not be read. Try again." };
  if (!l) return { ok: false, error: "Label not found." };
  if (l.status !== "active") return { ok: false, error: "This label is already voided." };
  // The carrier would still come for it (the database refuses this too).
  const { count: pickups, error: pickupError } = await db
    .from("shipment_pickups")
    .select("id", { count: "exact", head: true })
    .eq("label_id", l.id)
    .eq("status", "scheduled");
  if (pickupError) return { ok: false, error: "The label could not be read. Try again." };
  if ((pickups ?? 0) > 0) return { ok: false, error: "This label has a carrier pickup booked. Cancel the pickup before voiding the label." };

  let message = "Test label voided in the portal (ShipStation does not keep test labels).";
  if (!l.is_test) {
    const config = shipStationConfig();
    if (!config) return { ok: false, error: "ShipStation is not configured (SHIPSTATION_API_KEY)." };
    try {
      const res = await shipStationRequest<{ approved?: boolean; message?: string }>(
        config.apiKey,
        "PUT",
        `labels/${encodeURIComponent(l.shipstation_label_id)}/void`,
      );
      if (!res.approved) {
        await logSync(db, "label_void", l.shipment_id, "rejected", l.shipstation_label_id, res.message ?? "not approved");
        return { ok: false, error: `The carrier did not approve the void: ${res.message ?? "no reason given"}.` };
      }
      message = res.message?.trim() || "Label voided. The refund follows from the carrier.";
    } catch (e) {
      await logSync(db, "label_void", l.shipment_id, "error", l.shipstation_label_id, failure(e));
      return { ok: false, error: `ShipStation could not void the label: ${failure(e)}` };
    }
  }
  const { error: rpcError } = await db.rpc("cds_void_shipment_label", { p_label: l.id, p_message: message.slice(0, 1000) });
  if (rpcError) return { ok: false, error: `The label was voided in ShipStation but not in the portal: ${rpcError.message}` };
  return { ok: true, message };
}
