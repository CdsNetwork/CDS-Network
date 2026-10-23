import { describe, expect, it } from "vitest";
import {
  buildLabelRequest,
  buildPackage,
  buildRatesRequest,
  mapLabel,
  mapRates,
  ratesFailureMessage,
  toShipAddress,
  type PortalAddress,
} from "@/lib/shipstation/requests";
import { errorMessage, ShipStationError } from "@/lib/shipstation/client";
import { shipStationConfig } from "@/lib/shipstation/config";

const LOCATION: PortalAddress = {
  name: "Shipping / Receiving",
  company: "Ryder 0412 Phoenix",
  phone: "602-555-0100",
  line1: "4500 W Buckeye Rd",
  line2: null,
  city: "Phoenix",
  region: "AZ",
  postalCode: "85043",
  country: "US",
};

const SHOP: PortalAddress = {
  name: "Service Manager",
  company: "Desert Diesel Service",
  phone: "602-555-0142",
  line1: "1001 S 7th St",
  city: "Phoenix",
  region: "az",
  postalCode: "85034",
  country: "US",
};

describe("toShipAddress", () => {
  it("maps portal fields to the ShipStation address shape", () => {
    const r = toShipAddress(SHOP, "Shop");
    expect(r).toEqual({
      ok: true,
      address: {
        name: "Service Manager",
        company_name: "Desert Diesel Service",
        phone: "602-555-0142",
        address_line1: "1001 S 7th St",
        city_locality: "Phoenix",
        state_province: "AZ",
        postal_code: "85034",
        country_code: "US",
        address_residential_indicator: "no",
      },
    });
  });

  it("uses the company as the name when no contact name is known", () => {
    const r = toShipAddress({ ...SHOP, name: "  " }, "Shop");
    expect(r.ok && r.address.name).toBe("Desert Diesel Service");
  });

  it("keeps line 2 when present and pads a 4 digit US ZIP", () => {
    const r = toShipAddress({ ...LOCATION, line2: "Dock 4", postalCode: "3103" }, "Location");
    expect(r.ok && r.address.address_line2).toBe("Dock 4");
    expect(r.ok && r.address.postal_code).toBe("03103");
  });

  it("names the party and every missing field", () => {
    const r = toShipAddress({ company: "Shop X", phone: "330-555-0101", line1: "", city: "Akron", region: null, postalCode: "44301" }, "Shop");
    expect(r).toEqual({ ok: false, problem: "Shop address is missing street, state" });
  });

  it("needs a phone (FedEx refuses labels without one)", () => {
    const r = toShipAddress({ ...SHOP, phone: null }, "Shop");
    expect(r).toEqual({ ok: false, problem: "Shop address is missing phone" });
  });

  it("needs a name or a company", () => {
    const r = toShipAddress({ ...SHOP, name: null, company: null }, "Shop");
    expect(r).toEqual({ ok: false, problem: "Shop address is missing name" });
  });
});

describe("buildPackage", () => {
  it("builds weight in pounds and dimensions in inches", () => {
    expect(buildPackage({ weightLb: 45, lengthIn: 24, widthIn: 20, heightIn: 20 })).toEqual({
      weight: { value: 45, unit: "pound" },
      dimensions: { unit: "inch", length: 24, width: 20, height: 20 },
    });
  });

  it("leaves dimensions out when any is missing", () => {
    expect(buildPackage({ weightLb: 12.5, lengthIn: 10, widthIn: null, heightIn: 4 })).toEqual({
      weight: { value: 12.5, unit: "pound" },
    });
  });

  it("refuses a weight of zero or below, or above 150 lb", () => {
    expect(() => buildPackage({ weightLb: 0 })).toThrow(/weight/i);
    expect(() => buildPackage({ weightLb: 151 })).toThrow(/150/);
  });
});

function addresses() {
  const from = toShipAddress(LOCATION, "Location");
  const to = toShipAddress(SHOP, "Shop");
  if (!from.ok || !to.ok) throw new Error("fixture addresses must be valid");
  return { shipFrom: from.address, shipTo: to.address };
}

describe("buildRatesRequest", () => {
  it("asks for rates from the configured carriers only, without address validation", () => {
    const body = buildRatesRequest({
      ...addresses(),
      carrierIds: ["se-7157832"],
      pkg: { weightLb: 45, lengthIn: 24, widthIn: 20, heightIn: 20 },
    });
    expect(body.rate_options).toEqual({ carrier_ids: ["se-7157832"] });
    expect(body.shipment.validate_address).toBe("no_validation");
    expect(body.shipment.ship_from.city_locality).toBe("Phoenix");
    expect(body.shipment.ship_to.company_name).toBe("Desert Diesel Service");
    expect(body.shipment.packages).toHaveLength(1);
    expect(body.shipment.packages[0].weight).toEqual({ value: 45, unit: "pound" });
  });

  it("passes service codes when given", () => {
    const body = buildRatesRequest({
      ...addresses(),
      carrierIds: ["se-1", "se-2"],
      serviceCodes: ["fedex_ground"],
      pkg: { weightLb: 5 },
    });
    expect(body.rate_options).toEqual({ carrier_ids: ["se-1", "se-2"], service_codes: ["fedex_ground"] });
  });

  it("needs at least one carrier", () => {
    expect(() => buildRatesRequest({ ...addresses(), carrierIds: [], pkg: { weightLb: 5 } })).toThrow(/carrier/i);
  });
});

describe("buildLabelRequest", () => {
  it("builds a PDF 4x6 label with a download URL and the test flag", () => {
    const body = buildLabelRequest({
      ...addresses(),
      carrierId: "se-7157832",
      serviceCode: "fedex_ground",
      pkg: { weightLb: 45, lengthIn: 24, widthIn: 20, heightIn: 20 },
      testLabel: true,
      reference: "WO 100123",
      externalShipmentId: "4a0d9c35-0000-4000-8000-000000000001",
    });
    expect(body.test_label).toBe(true);
    expect(body.label_format).toBe("pdf");
    expect(body.label_layout).toBe("4x6");
    expect(body.label_download_type).toBe("url");
    expect(body.shipment.carrier_id).toBe("se-7157832");
    expect(body.shipment.service_code).toBe("fedex_ground");
    expect(body.shipment.external_shipment_id).toBe("4a0d9c35-0000-4000-8000-000000000001");
    expect(body.shipment.packages[0].label_messages).toEqual({ reference1: "WO 100123" });
  });

  it("sends test_label false for a real label", () => {
    const body = buildLabelRequest({
      ...addresses(),
      carrierId: "se-1",
      serviceCode: "fedex_2day",
      pkg: { weightLb: 3 },
      testLabel: false,
      reference: "WO 1",
      externalShipmentId: "x",
    });
    expect(body.test_label).toBe(false);
  });

  it("cuts the reference to the 35 characters carriers print", () => {
    const body = buildLabelRequest({
      ...addresses(),
      carrierId: "se-1",
      serviceCode: "s",
      pkg: { weightLb: 3 },
      testLabel: true,
      reference: "WO 100123 ".repeat(10),
      externalShipmentId: "x",
    });
    expect(body.shipment.packages[0].label_messages.reference1.length).toBeLessThanOrEqual(35);
  });

  it("needs a carrier and a service", () => {
    expect(() =>
      buildLabelRequest({ ...addresses(), carrierId: "", serviceCode: "x", pkg: { weightLb: 1 }, testLabel: true, reference: "", externalShipmentId: "x" }),
    ).toThrow(/carrier/i);
    expect(() =>
      buildLabelRequest({ ...addresses(), carrierId: "se-1", serviceCode: " ", pkg: { weightLb: 1 }, testLabel: true, reference: "", externalShipmentId: "x" }),
    ).toThrow(/service/i);
  });
});

// Shape of a real POST /v2/rates answer (2026-10-18), trimmed.
const RATES_RESPONSE = {
  rate_response: {
    status: "completed",
    errors: [],
    rates: [
      {
        rate_id: "se-r1",
        carrier_id: "se-7157832",
        carrier_code: "fedex",
        carrier_friendly_name: "FedEx",
        service_code: "fedex_2day",
        service_type: "FedEx 2Day®",
        shipping_amount: { currency: "usd", amount: 64.69 },
        other_amount: { currency: "usd", amount: 20.7 },
        insurance_amount: { currency: "usd", amount: 0 },
        confirmation_amount: { currency: "usd", amount: 0 },
        delivery_days: 3,
        estimated_delivery_date: "2026-10-22T00:00:00Z",
        warning_messages: [],
        error_messages: [],
      },
      {
        rate_id: "se-r2",
        carrier_id: "se-7157832",
        carrier_code: "fedex",
        service_code: "fedex_ground",
        service_type: "FedEx Ground®",
        shipping_amount: { currency: "usd", amount: 16.14 },
        other_amount: { currency: "usd", amount: 4.64 },
        insurance_amount: { currency: "usd", amount: 0 },
        confirmation_amount: { currency: "usd", amount: 0 },
        delivery_days: 3,
        estimated_delivery_date: "2026-10-22T06:59:00Z",
        warning_messages: ["FedEx may add a Home Delivery Surcharge to this shipment later if this is a residential address."],
        error_messages: [],
      },
      {
        rate_id: "se-r3",
        carrier_id: "se-7157770",
        carrier_code: "ups",
        service_code: "ups_ground",
        service_type: "UPS® Ground",
        shipping_amount: { currency: "usd", amount: 40.42 },
        other_amount: { currency: "usd", amount: 0 },
        delivery_days: 2,
        warning_messages: [],
        error_messages: [],
      },
    ],
    invalid_rates: [
      { carrier_id: "se-7157832", service_code: "fedex_first_overnight", error_messages: ["Not available to this ZIP"] },
    ],
  },
};

describe("mapRates", () => {
  it("adds up every charge, sorts cheapest first and keeps warnings", () => {
    const { rates, problems } = mapRates(RATES_RESPONSE);
    expect(rates.map((r) => r.serviceCode)).toEqual(["fedex_ground", "ups_ground", "fedex_2day"]);
    expect(rates[0]).toMatchObject({
      rateId: "se-r2",
      carrierId: "se-7157832",
      carrierCode: "fedex",
      serviceName: "FedEx Ground®",
      total: 20.78,
      shipping: 16.14,
      other: 4.64,
      currency: "USD",
      deliveryDays: 3,
      estimatedDelivery: "2026-10-22T06:59:00Z",
    });
    expect(rates[0].warnings).toHaveLength(1);
    expect(rates[2].total).toBe(85.39);
    expect(problems).toEqual(["fedex_first_overnight: Not available to this ZIP"]);
  });

  it("keeps only the services CDS allows for each carrier", () => {
    const { rates } = mapRates(RATES_RESPONSE, {
      "se-7157832": ["fedex_ground"],
    });
    expect(rates.map((r) => r.serviceCode)).toEqual(["fedex_ground", "ups_ground"]);
  });

  it("an empty allow list for a carrier means all of its services", () => {
    const { rates } = mapRates(RATES_RESPONSE, { "se-7157832": [] });
    expect(rates).toHaveLength(3);
  });

  it("reports request level errors", () => {
    const { rates, problems } = mapRates({
      rate_response: { status: "error", rates: [], errors: [{ message: "Invalid postal code" }] },
    });
    expect(rates).toEqual([]);
    expect(problems).toEqual(["Invalid postal code"]);
  });

  it("drops rates with errors", () => {
    const { rates } = mapRates({
      rate_response: {
        rates: [{ rate_id: "x", carrier_id: "c", service_code: "s", shipping_amount: { amount: 5 }, error_messages: ["bad"] }],
      },
    });
    expect(rates).toEqual([]);
  });

  it("lists each carrier service once (USPS answers one rate per package type)", () => {
    const usps = (id: string, service: string, name: string, amt: number, pkg: string | null) => ({
      rate_id: id,
      rate_type: "shipment",
      carrier_id: "se-usps",
      carrier_code: "usps",
      service_code: service,
      service_type: name,
      package_type: pkg,
      shipping_amount: { currency: "usd", amount: amt },
      other_amount: { currency: "usd", amount: 0 },
      delivery_days: 3,
    });
    const { rates } = mapRates({
      rate_response: {
        rates: [
          usps("se-a1", "usps_ground_advantage", "USPS Ground Advantage", 107.73, "package"),
          usps("se-a2", "usps_ground_advantage", "USPS Ground Advantage", 107.73, null),
          usps("se-b1", "usps_priority_mail", "USPS Priority Mail", 133.95, "package"),
          usps("se-b2", "usps_priority_mail", "USPS Priority Mail", 22.45, "medium_flat_rate_box"),
          usps("se-b3", "usps_priority_mail", "USPS Priority Mail", 140.1, "large_package"),
          usps("se-c1", "usps_priority_mail_express", "USPS Priority Mail Express", 31.4, "flat_rate_envelope"),
        ],
      },
    });
    expect(rates.map((r) => r.serviceCode)).toEqual([
      "usps_priority_mail_express",
      "usps_ground_advantage",
      "usps_priority_mail",
    ]);
    // The label is bought for CDS's own box, so a flat rate price would be misleading when a
    // plain package rate exists; it is kept only when nothing else is offered for the service.
    expect(rates.find((r) => r.serviceCode === "usps_priority_mail")).toMatchObject({ rateId: "se-b1", total: 133.95 });
    expect(rates.find((r) => r.serviceCode === "usps_ground_advantage")?.total).toBe(107.73);
    expect(rates.find((r) => r.serviceCode === "usps_priority_mail_express")?.serviceName).toBe(
      "USPS Priority Mail Express (flat rate envelope)",
    );
  });

  it("shows a short message when a carrier is down upstream and keeps the raw text out of problems", () => {
    // UPS failed upstream on the first run of QA m2-r9 (2026-10-20); FedEx still answered.
    const raw = "A shipping carrier error occurred: Request failed with status code 500 (Generic). (520, req-1)";
    const { rates, problems, upstream } = mapRates({
      rate_response: {
        status: "partial",
        rates: RATES_RESPONSE.rate_response.rates.filter((r) => r.carrier_code === "fedex"),
        errors: [
          {
            error_source: "carrier",
            error_type: "system",
            error_code: "unspecified",
            message: raw,
            carrier_id: "se-7157770",
            carrier_code: "ups",
            carrier_name: "UPS",
          },
        ],
      },
    });
    expect(rates.map((r) => r.carrierCode)).toEqual(["fedex", "fedex"]);
    expect(problems).toEqual(["UPS rates are temporarily unavailable, try again in a minute."]);
    expect(problems.join(" ")).not.toContain("status code");
    expect(upstream).toEqual([raw]);
  });

  it("recognises an upstream failure by its text even without a carrier error type", () => {
    const { problems, upstream } = mapRates({
      rate_response: {
        rates: [],
        errors: [{ message: "A shipping carrier error occurred: Request failed with status code 503", carrier_code: "fedex" }],
        invalid_rates: [{ carrier_id: "se-9", carrier_code: "ups", service_code: "ups_ground", error_messages: ["The carrier timed out"] }],
      },
    });
    expect(problems).toEqual([
      "FedEx rates are temporarily unavailable, try again in a minute.",
      "UPS rates are temporarily unavailable, try again in a minute.",
    ]);
    expect(upstream).toHaveLength(2);
  });

  it("names each unavailable carrier once", () => {
    const err = { error_source: "carrier", error_type: "system", message: "Request failed with status code 500", carrier_code: "ups" };
    const { problems } = mapRates({ rate_response: { rates: [], errors: [err, err] } });
    expect(problems).toEqual(["UPS rates are temporarily unavailable, try again in a minute."]);
  });

  it("keeps validation messages that staff can act on", () => {
    const { problems, upstream } = mapRates({
      rate_response: { rates: [], errors: [{ error_source: "carrier", error_type: "validation", message: "Invalid postal code", carrier_code: "ups" }] },
    });
    expect(problems).toEqual(["Invalid postal code"]);
    expect(upstream).toEqual([]);
  });

  it("survives a body without rate_response", () => {
    expect(mapRates(null)).toEqual({ rates: [], problems: ["ShipStation returned no rates"], upstream: [] });
  });
});

// Shape of a real POST /v2/labels answer for a test label (2026-10-18), trimmed.
const TEST_LABEL = {
  label_id: "se-test-472415979",
  status: "processing",
  shipment_id: "se-472415979",
  ship_date: "2026-10-18T20:10:53.1136182Z",
  shipment_cost: { currency: "usd", amount: 0 },
  insurance_cost: { currency: "usd", amount: 0 },
  tracking_number: "9999999999999",
  is_return_label: false,
  carrier_id: "se-7157769",
  carrier_code: "usps",
  service_code: "usps_ground_advantage",
  voided: false,
  trackable: true,
  tracking_status: "unknown",
  label_download: { href: "https://api.shipstation.com/v2/downloads/14/abc/label.pdf" },
  tracking_url: null,
};

describe("mapLabel", () => {
  it("maps the fields the portal keeps", () => {
    const label = mapLabel(TEST_LABEL, true);
    expect(label).toEqual({
      labelId: "se-test-472415979",
      shipmentId: "se-472415979",
      carrierId: "se-7157769",
      carrierCode: "usps",
      serviceCode: "usps_ground_advantage",
      trackingNumber: "9999999999999",
      isTest: true,
      pdfUrl: "https://api.shipstation.com/v2/downloads/14/abc/label.pdf",
      trackingUrl: null,
      cost: 0,
      insurance: 0,
      currency: "USD",
      status: "processing",
    });
  });

  it("treats a se-test- label id as a test label even if the flag was not sent", () => {
    expect(mapLabel(TEST_LABEL, false).isTest).toBe(true);
  });

  it("a real label is not a test label and prefers the pdf link", () => {
    const label = mapLabel(
      {
        ...TEST_LABEL,
        label_id: "se-123",
        tracking_number: "794600000000",
        shipment_cost: { currency: "usd", amount: 20.78 },
        label_download: { pdf: "https://x.test/a.pdf", href: "https://x.test/a" },
      },
      false,
    );
    expect(label.isTest).toBe(false);
    expect(label.pdfUrl).toBe("https://x.test/a.pdf");
    expect(label.cost).toBe(20.78);
  });

  it("refuses an answer without a label id", () => {
    expect(() => mapLabel({ status: "error" }, true)).toThrow(/label/i);
  });
});

describe("errorMessage", () => {
  it("joins the ShipStation error messages", () => {
    expect(
      errorMessage(
        {
          request_id: "r1",
          errors: [
            { error_source: "shipengine", error_type: "system", message: "FedEx (7157832) does not support test labels" },
            { message: "second" },
          ],
        },
        "fallback",
      ),
    ).toBe("FedEx (7157832) does not support test labels; second");
  });

  it("falls back when there is no error list", () => {
    expect(errorMessage({ foo: 1 }, "ShipStation returned HTTP 500")).toBe("ShipStation returned HTTP 500");
    expect(errorMessage(null, "x")).toBe("x");
  });

  it("ShipStationError knows a rate limit and a refusal", () => {
    expect(new ShipStationError("slow down", 429).rateLimited).toBe(true);
    expect(new ShipStationError("bad", 400).rejected).toBe(true);
    expect(new ShipStationError("down", 0).rejected).toBe(false);
  });
});

describe("shipStationConfig", () => {
  it("is null without an API key", () => {
    expect(shipStationConfig({})).toBeNull();
  });

  it("makes test labels unless SHIPSTATION_TEST_LABELS is false", () => {
    expect(shipStationConfig({ SHIPSTATION_API_KEY: "k" })?.testLabels).toBe(true);
    expect(shipStationConfig({ SHIPSTATION_API_KEY: "k", SHIPSTATION_TEST_LABELS: "true" })?.testLabels).toBe(true);
    expect(shipStationConfig({ SHIPSTATION_API_KEY: "k", SHIPSTATION_TEST_LABELS: "yes" })?.testLabels).toBe(true);
    expect(shipStationConfig({ SHIPSTATION_API_KEY: "k", SHIPSTATION_TEST_LABELS: "false" })?.testLabels).toBe(false);
    expect(shipStationConfig({ SHIPSTATION_API_KEY: "k", SHIPSTATION_TEST_LABELS: " FALSE " })?.testLabels).toBe(false);
  });

  it("reads the optional webhook token", () => {
    expect(shipStationConfig({ SHIPSTATION_API_KEY: "k" })?.webhookToken).toBeNull();
    expect(shipStationConfig({ SHIPSTATION_API_KEY: "k", SHIPSTATION_WEBHOOK_TOKEN: " abc " })?.webhookToken).toBe("abc");
  });
});

describe("ratesFailureMessage", () => {
  it("hides the raw text when ShipStation or a carrier is down", () => {
    expect(ratesFailureMessage(new ShipStationError("A shipping carrier error occurred: Request failed with status code 500", 500))).toBe(
      "Rates are temporarily unavailable, try again in a minute.",
    );
    expect(ratesFailureMessage(new ShipStationError("ShipStation could not be reached (fetch failed)", 0))).toBe(
      "Rates are temporarily unavailable, try again in a minute.",
    );
  });

  it("keeps ShipStation's own message for a request it refused", () => {
    expect(ratesFailureMessage(new ShipStationError("ship_to.postal_code is invalid", 400))).toBe("ShipStation rates failed: ship_to.postal_code is invalid");
    expect(ratesFailureMessage(new ShipStationError("ShipStation is busy (rate limit reached). Try again in a minute.", 429))).toBe(
      "ShipStation rates failed: ShipStation is busy (rate limit reached). Try again in a minute.",
    );
  });
});
