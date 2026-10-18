import { describe, expect, it } from "vitest";
import { locationKey, matchCustomer, matchItem, matchLocation, partKey } from "@/lib/intake/match";
import {
  aliases,
  AMAZON,
  BOX_BAKE,
  catalog,
  customers,
  domains,
  DOC_CLEAN,
  DPF_CLEAN,
  DPF_GASKET,
  EGR,
  FIRST_STUDENT,
  loc0077,
  loc0424,
  locations,
  locFs12723,
  RYDER,
  VBAND_CLAMP,
} from "../fixtures/intake/reference";

const ryderLocs = locations.filter((l) => l.customer_id === RYDER);
const noLoc = { numbers: [], name: null, address: null, zip: null, text: "" };

describe("keys", () => {
  it("normalizes part numbers and location numbers", () => {
    expect(partKey(" fs-gsk 1201 ")).toBe("FSGSK1201");
    expect(locationKey("0424")).toBe("424");
    expect(locationKey("0")).toBe("0");
  });
});

describe("matchCustomer", () => {
  it("matches by sender domain, including subdomains", () => {
    const r = matchCustomer({ senders: ["no-reply@portal.firststudent.example"], text: "", llmCustomerName: null }, customers, domains);
    expect(r.match).toMatchObject({ id: FIRST_STUDENT, via: "sender_domain" });
  });

  it("does not match a lookalike domain", () => {
    const r = matchCustomer({ senders: ["x@notryder.example"], text: "", llmCustomerName: null }, customers, domains);
    expect(r.match).toBeNull();
  });

  it("uses the first sender that matches (original author of a forward)", () => {
    const r = matchCustomer(
      { senders: ["dispatch@cds.direct", "shop@ryder.example"], text: "", llmCustomerName: null },
      customers,
      domains,
    );
    expect(r.match?.id).toBe(RYDER);
  });

  it("falls back to a single customer named in the text", () => {
    const r = matchCustomer({ senders: ["someone@gmail.example"], text: "This is for our Amazon site", llmCustomerName: null }, customers, domains);
    expect(r.match).toMatchObject({ id: AMAZON, via: "content", confidence: 0.7 });
  });

  it("returns candidates instead of guessing when two customers are named", () => {
    const r = matchCustomer({ senders: [], text: "Ryder and First Student both", llmCustomerName: null }, customers, domains);
    expect(r.match).toBeNull();
    expect(r.candidates.map((c) => c.id).sort()).toEqual([RYDER, FIRST_STUDENT].sort());
  });

  it("uses the AI's customer name last, matched to a real customer in code", () => {
    const r = matchCustomer({ senders: [], text: "", llmCustomerName: "First Student Inc." }, customers, domains);
    expect(r.match).toMatchObject({ id: FIRST_STUDENT, via: "llm_name" });
    expect(matchCustomer({ senders: [], text: "", llmCustomerName: "Unknown Fleet" }, customers, domains).match).toBeNull();
  });
});

describe("matchLocation", () => {
  it("matches a location number with leading zeros, not a longer number", () => {
    const r = matchLocation({ ...noLoc, numbers: ["0424"] }, ryderLocs);
    expect(r.match).toMatchObject({ id: loc0424.id, via: "location_number", confidence: 0.95 });
  });

  it("matches a First Student department code", () => {
    const r = matchLocation({ ...noLoc, numbers: ["12723M"] }, locations.filter((l) => l.customer_id === FIRST_STUDENT));
    expect(r.match?.id).toBe(locFs12723.id);
  });

  it("matches by street number and ZIP when there is no location number", () => {
    const r = matchLocation({ ...noLoc, address: "1180 Industrial Pkwy, Fairview, OH 44126" }, ryderLocs);
    expect(r.match).toMatchObject({ id: loc0077.id, via: "address", confidence: 0.85 });
  });

  it("lists candidates when only the ZIP is known and two locations share it", () => {
    const r = matchLocation({ ...noLoc, zip: "44126", text: "somewhere in Fairview" }, ryderLocs);
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(2);
  });

  it("matches by name", () => {
    expect(matchLocation({ ...noLoc, name: "North Haven" }, ryderLocs).match?.via).toBe("name");
  });

  it("returns nothing for an unknown number", () => {
    expect(matchLocation({ ...noLoc, numbers: ["9999"] }, ryderLocs)).toEqual({ match: null, candidates: [] });
  });
});

describe("matchItem", () => {
  const m = (description: string, partNumber: string | null = null, component: "DPF" | "DOC" | "EGR" | null = null, customer: string | null = RYDER) =>
    matchItem({ description, partNumber, qty: null, component, source: "llm" }, customer, catalog, aliases);

  it("matches the customer's own part number first", () => {
    expect(m("Gasket, DPF inlet", "FS-GSK-1201", null, FIRST_STUDENT)).toMatchObject({
      catalog_item_id: DPF_GASKET.id,
      via: "customer_alias",
      confidence: 0.95,
      qty: 1,
    });
  });

  it("ignores another customer's part numbers", () => {
    expect(m("clamp", "FS-CLP-0310", null, RYDER).via).not.toBe("customer_alias");
  });

  it("matches our SKU and OE cross references", () => {
    expect(m("clamp", "cds-c-4000")).toMatchObject({ catalog_item_id: VBAND_CLAMP.id, via: "sku" });
    expect(m("gasket", "2871999")).toMatchObject({ catalog_item_id: DPF_GASKET.id, via: "oe_cross" });
  });

  it("matches a component cleaning request to that component's service", () => {
    expect(m("DPF clean", null, "DPF")).toMatchObject({ catalog_item_id: DPF_CLEAN.id, via: "name" });
    expect(m("DOC cleaning", null, "DOC").catalog_item_id).toBe(DOC_CLEAN.id);
    expect(m("clean and bake the DPF", null, "DPF").catalog_item_id).toBe(DPF_CLEAN.id);
    expect(m("EGR cooler cleaning", null, "EGR").catalog_item_id).toBe(EGR.id);
  });

  it("does not send a DPF request to a service for another component", () => {
    expect(m("bake and clean", null, "DPF").catalog_item_id).not.toBe(BOX_BAKE.id);
  });

  it("leaves unclear items unmatched for CDS", () => {
    expect(m("something odd", "ZZ-999")).toMatchObject({ catalog_item_id: null, via: "none", confidence: 0 });
  });
});
