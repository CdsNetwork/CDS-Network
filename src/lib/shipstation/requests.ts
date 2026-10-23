/**
 * Request bodies for the ShipStation V2 rates and labels endpoints, and mapping of their
 * answers. Pure functions: no network, no database.
 *
 * Shapes checked against live answers on 2026-10-18:
 *   POST /v2/rates   { rate_options: { carrier_ids, service_codes? }, shipment: { ship_from, ship_to, packages } }
 *                    -> { rate_response: { rates[], invalid_rates[], errors[], status } }
 *   POST /v2/labels  { shipment: { carrier_id, service_code, ... }, test_label, label_format, label_layout, label_download_type }
 *                    -> { label_id, shipment_id, tracking_number, shipment_cost, label_download: { pdf?, href }, ... }
 * A test label has a label_id starting with "se-test-", tracking number 9999999999999 and cost 0.
 */

export type PortalAddress = {
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  residential?: boolean;
};

export type ShipAddress = {
  name: string;
  company_name?: string;
  phone: string;
  email?: string;
  address_line1: string;
  address_line2?: string;
  city_locality: string;
  state_province: string;
  postal_code: string;
  country_code: string;
  address_residential_indicator: "yes" | "no";
};

function clean(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

/**
 * A portal address (customer location, shop or CDS) as a ShipStation address. `party` names
 * the address in the problem text ("Shop address is missing phone").
 */
export function toShipAddress(
  a: PortalAddress,
  party: string,
): { ok: true; address: ShipAddress } | { ok: false; problem: string } {
  const company = clean(a.company);
  const name = clean(a.name) || company;
  const country = (clean(a.country) || "US").toUpperCase();
  let postal = clean(a.postalCode);
  // Spreadsheet imports lost the leading zero of New England and New Jersey ZIPs.
  if (country === "US" && /^\d{4}$/.test(postal)) postal = `0${postal}`;

  const missing: string[] = [];
  if (!name) missing.push("name");
  if (!clean(a.line1)) missing.push("street");
  if (!clean(a.city)) missing.push("city");
  if (!clean(a.region)) missing.push("state");
  if (!postal) missing.push("ZIP");
  if (!clean(a.phone)) missing.push("phone");
  if (missing.length) return { ok: false, problem: `${party} address is missing ${missing.join(", ")}` };

  const address: ShipAddress = {
    name: name.slice(0, 35),
    ...(company ? { company_name: company.slice(0, 35) } : {}),
    phone: clean(a.phone),
    ...(clean(a.email) ? { email: clean(a.email) } : {}),
    address_line1: clean(a.line1),
    ...(clean(a.line2) ? { address_line2: clean(a.line2) } : {}),
    city_locality: clean(a.city),
    state_province: clean(a.region).toUpperCase(),
    postal_code: postal,
    country_code: country,
    address_residential_indicator: a.residential ? "yes" : "no",
  };
  return { ok: true, address };
}

export type PackageInput = {
  weightLb: number;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
};

export type ShipPackage = {
  weight: { value: number; unit: "pound" };
  dimensions?: { unit: "inch"; length: number; width: number; height: number };
};

/** FedEx and UPS parcel services stop at 150 lb; heavier parts go as freight. */
export const MAX_PARCEL_LB = 150;

export function buildPackage(p: PackageInput): ShipPackage {
  if (!Number.isFinite(p.weightLb) || p.weightLb <= 0) throw new Error("Enter the package weight in pounds.");
  if (p.weightLb > MAX_PARCEL_LB) throw new Error(`Parcel labels are limited to ${MAX_PARCEL_LB} lb; ship heavier parts as freight.`);
  const dims = [p.lengthIn, p.widthIn, p.heightIn];
  const hasDims = dims.every((d) => typeof d === "number" && Number.isFinite(d) && d > 0);
  return {
    weight: { value: p.weightLb, unit: "pound" },
    ...(hasDims
      ? { dimensions: { unit: "inch" as const, length: p.lengthIn as number, width: p.widthIn as number, height: p.heightIn as number } }
      : {}),
  };
}

type ShipmentParts = { shipFrom: ShipAddress; shipTo: ShipAddress; pkg: PackageInput };

export type RatesRequest = {
  rate_options: { carrier_ids: string[]; service_codes?: string[] };
  shipment: {
    validate_address: "no_validation";
    ship_from: ShipAddress;
    ship_to: ShipAddress;
    packages: ShipPackage[];
  };
};

/** Body for POST /v2/rates. */
export function buildRatesRequest(input: ShipmentParts & { carrierIds: string[]; serviceCodes?: string[] }): RatesRequest {
  const carrierIds = input.carrierIds.map((c) => c.trim()).filter(Boolean);
  if (!carrierIds.length) throw new Error("No carrier is set up for rates. Add one under Shipping settings.");
  const serviceCodes = (input.serviceCodes ?? []).map((s) => s.trim()).filter(Boolean);
  return {
    rate_options: { carrier_ids: carrierIds, ...(serviceCodes.length ? { service_codes: serviceCodes } : {}) },
    shipment: {
      // CDS reviews every address; ShipStation's address validation is a paid add-on.
      validate_address: "no_validation",
      ship_from: input.shipFrom,
      ship_to: input.shipTo,
      packages: [buildPackage(input.pkg)],
    },
  };
}

export type LabelRequest = {
  test_label: boolean;
  label_format: "pdf";
  label_layout: "4x6";
  label_download_type: "url";
  shipment: {
    carrier_id: string;
    service_code: string;
    external_shipment_id: string;
    validate_address: "no_validation";
    ship_from: ShipAddress;
    ship_to: ShipAddress;
    packages: (ShipPackage & { label_messages: { reference1: string } })[];
  };
};

/** Body for POST /v2/labels. `reference` is printed on the label (carriers print up to 35 characters). */
export function buildLabelRequest(
  input: ShipmentParts & { carrierId: string; serviceCode: string; testLabel: boolean; reference: string; externalShipmentId: string },
): LabelRequest {
  const carrierId = input.carrierId.trim();
  const serviceCode = input.serviceCode.trim();
  if (!carrierId) throw new Error("Choose a carrier.");
  if (!serviceCode) throw new Error("Choose a service.");
  return {
    test_label: input.testLabel,
    label_format: "pdf",
    label_layout: "4x6",
    label_download_type: "url",
    shipment: {
      carrier_id: carrierId,
      service_code: serviceCode,
      external_shipment_id: input.externalShipmentId,
      validate_address: "no_validation",
      ship_from: input.shipFrom,
      ship_to: input.shipTo,
      packages: [{ ...buildPackage(input.pkg), label_messages: { reference1: clean(input.reference).slice(0, 35) } }],
    },
  };
}

// ---------------------------------------------------------------- rates

type Money = { amount?: number | string | null; currency?: string | null } | null | undefined;

type RawRate = {
  rate_id?: string;
  carrier_id?: string;
  carrier_code?: string;
  carrier_friendly_name?: string;
  service_code?: string;
  service_type?: string;
  package_type?: string | null;
  shipping_amount?: Money;
  other_amount?: Money;
  insurance_amount?: Money;
  confirmation_amount?: Money;
  delivery_days?: number | null;
  estimated_delivery_date?: string | null;
  warning_messages?: string[];
  error_messages?: string[];
};

export type Rate = {
  rateId: string;
  carrierId: string;
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
  /** ShipStation package type of this rate, null for a plain package. */
  packageType: string | null;
  /** shipping + other + insurance + confirmation, what CDS pays. */
  total: number;
  shipping: number;
  other: number;
  currency: string;
  deliveryDays: number | null;
  estimatedDelivery: string | null;
  warnings: string[];
};

function amount(m: Money): number {
  const n = Number(m?.amount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const isPlainPackage = (t: string | null) => t === null || t === "package";

/**
 * One rate per carrier service. ShipStation answers USPS with one rate per package type (plain
 * package, flat rate boxes, large package), often with identical text. The label is bought for
 * the carrier and service with CDS's own package, so a plain package rate wins when there is
 * one; otherwise the cheapest rate is kept and its package type is named.
 */
function onePerService(rates: Rate[]): Rate[] {
  const best = new Map<string, Rate>();
  for (const r of rates) {
    const key = `${r.carrierId}|${r.serviceCode}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, r);
      continue;
    }
    const rPlain = isPlainPackage(r.packageType);
    const curPlain = isPlainPackage(cur.packageType);
    if ((rPlain && !curPlain) || (rPlain === curPlain && r.total < cur.total)) best.set(key, r);
  }
  return [...best.values()].map((r) =>
    isPlainPackage(r.packageType) ? r : { ...r, serviceName: `${r.serviceName} (${r.packageType!.replace(/_/g, " ")})` },
  );
}

type RawRateError = {
  message?: string;
  error_source?: string;
  error_type?: string;
  carrier_id?: string;
  carrier_code?: string;
  carrier_name?: string;
  carrier_friendly_name?: string;
};

const CARRIER_NAMES: Record<string, string> = { ups: "UPS", fedex: "FedEx", usps: "USPS", stamps_com: "USPS", dhl_express: "DHL Express" };

/**
 * A carrier failing on its side (seen 2026-10-20: UPS answered "A shipping carrier error occurred:
 * Request failed with status code 500 (Generic). (520, ...)"). Nothing CDS can fix, so staff get a
 * short retry hint instead of the carrier's raw text.
 */
const UPSTREAM_TEXT = /carrier error occurred|status code 5\d\d|\b5\d\d\b.*error|timed? ?out|temporarily|unavailable|try again later/i;

function isUpstream(e: { message: string; error_type?: string }): boolean {
  return e.error_type === "system" || UPSTREAM_TEXT.test(e.message);
}

function carrierLabel(e: { carrier_code?: string; carrier_name?: string; carrier_friendly_name?: string }): string {
  return CARRIER_NAMES[e.carrier_code ?? ""] ?? (e.carrier_friendly_name?.trim() || e.carrier_name?.trim() || "This carrier");
}

export const unavailableMessage = (carrier: string) => `${carrier} rates are temporarily unavailable, try again in a minute.`;

/**
 * Rates from a POST /v2/rates answer, one per carrier service, cheapest first. `allowed` maps a carrier id to the
 * service codes CDS allows (an empty list or a missing carrier allows all of its services).
 * `problems` is shown to CDS staff; `upstream` holds the raw text of carrier side failures, for the
 * server log only.
 */
export function mapRates(
  body: unknown,
  allowed: Record<string, string[]> = {},
): { rates: Rate[]; problems: string[]; upstream: string[] } {
  const rr = (body as { rate_response?: { rates?: RawRate[]; invalid_rates?: (RawRate & RawRateError)[]; errors?: RawRateError[] } } | null)
    ?.rate_response;
  if (!rr) return { rates: [], problems: ["ShipStation returned no rates"], upstream: [] };

  const problems: string[] = [];
  const upstream: string[] = [];
  const add = (message: string, source: RawRateError, prefix = "") => {
    if (isUpstream({ message, error_type: source.error_type })) {
      upstream.push(prefix + message);
      const friendly = unavailableMessage(carrierLabel(source));
      if (!problems.includes(friendly)) problems.push(friendly);
    } else {
      problems.push(prefix + message);
    }
  };
  for (const e of rr.errors ?? []) if (e?.message) add(e.message, e);
  for (const r of rr.invalid_rates ?? []) {
    const msg = (r.error_messages ?? []).join("; ");
    if (msg) add(msg, r, `${r.service_code ?? "rate"}: `);
  }

  const rates: Rate[] = [];
  for (const r of rr.rates ?? []) {
    if (!r.rate_id || !r.carrier_id || !r.service_code) continue;
    if ((r.error_messages ?? []).length) continue;
    const allow = allowed[r.carrier_id];
    if (allow && allow.length && !allow.includes(r.service_code)) continue;
    const shipping = amount(r.shipping_amount);
    const other = amount(r.other_amount);
    rates.push({
      rateId: r.rate_id,
      carrierId: r.carrier_id,
      carrierCode: r.carrier_code ?? "",
      serviceCode: r.service_code,
      serviceName: r.service_type ?? r.service_code,
      packageType: r.package_type?.trim() || null,
      total: round2(shipping + other + amount(r.insurance_amount) + amount(r.confirmation_amount)),
      shipping: round2(shipping),
      other: round2(other),
      currency: (r.shipping_amount?.currency ?? "usd").toUpperCase(),
      deliveryDays: typeof r.delivery_days === "number" ? r.delivery_days : null,
      estimatedDelivery: r.estimated_delivery_date ?? null,
      warnings: (r.warning_messages ?? []).filter((w) => typeof w === "string" && w.trim()),
    });
  }
  const unique = onePerService(rates);
  unique.sort((a, b) => a.total - b.total || (a.deliveryDays ?? 99) - (b.deliveryDays ?? 99));
  return { rates: unique, problems, upstream };
}

// ---------------------------------------------------------------- labels

export type CreatedLabel = {
  labelId: string;
  shipmentId: string | null;
  carrierId: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
  isTest: boolean;
  pdfUrl: string | null;
  trackingUrl: string | null;
  cost: number;
  insurance: number;
  currency: string;
  status: string | null;
};

type RawLabel = {
  label_id?: string;
  status?: string;
  shipment_id?: string;
  carrier_id?: string;
  carrier_code?: string;
  service_code?: string;
  tracking_number?: string;
  tracking_url?: string | null;
  shipment_cost?: Money;
  insurance_cost?: Money;
  label_download?: { pdf?: string; href?: string } | null;
};

/** The portal's view of a POST /v2/labels answer. */
export function mapLabel(body: unknown, testRequested: boolean): CreatedLabel {
  const l = (body ?? {}) as RawLabel;
  if (!l.label_id) throw new Error("ShipStation did not return the new label");
  return {
    labelId: l.label_id,
    shipmentId: l.shipment_id ?? null,
    carrierId: l.carrier_id ?? null,
    carrierCode: l.carrier_code ?? null,
    serviceCode: l.service_code ?? null,
    trackingNumber: l.tracking_number?.trim() || null,
    isTest: testRequested || l.label_id.startsWith("se-test-"),
    pdfUrl: l.label_download?.pdf ?? l.label_download?.href ?? null,
    trackingUrl: l.tracking_url ?? null,
    cost: round2(amount(l.shipment_cost)),
    insurance: round2(amount(l.insurance_cost)),
    currency: (l.shipment_cost?.currency ?? "usd").toUpperCase(),
    status: l.status ?? null,
  };
}

/**
 * What CDS staff see when the whole rates call fails. ShipStation or carrier outages (5xx, no
 * answer) get a short retry hint and the raw text stays in the server log; a request ShipStation
 * refused (4xx, rate limit) keeps its message because it says what to fix or when to retry.
 */
export function ratesFailureMessage(e: { message: string; status: number }): string {
  if (e.status === 0 || e.status >= 500) return "Rates are temporarily unavailable, try again in a minute.";
  return `ShipStation rates failed: ${e.message}`;
}
