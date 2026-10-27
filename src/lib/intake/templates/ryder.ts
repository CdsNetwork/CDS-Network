/**
 * Ryder "Clean Diesel Specialists Pick Up Request". Arrives through the ryder@cds.direct
 * Google Group, so the sender is not a Ryder address: detected by the subject
 * `***Ryder Location <num>-<NAME> has a ["DPF Cleaning ", ...] ready for pick up***` and the
 * form's labels in the body.
 */
import type { Component } from "../types";
import { countLabels, isoDate, miles, present, readLabels, type TemplateItem, type TemplateResult } from "./common";

const SUBJECT = /\*{3}\s*Ryder Location\s+(\d{1,6})\s*-\s*(.*?)\s+has an?\s+(\[.*?\]|.*?)\s+ready for pick\s?-?up\s*\*{3}/i;

const LABELS = [
  "Customer Name",
  "Region",
  "Date Requested",
  "Order Type",
  "Pick Up Location",
  "Pick Up Address",
  "Ship to City, State, ZIP",
  "Ship to City, State",
  "City",
  "State",
  "ZIP",
  "Unit #",
  "Manufacturer",
  "Miles",
  "Serial #",
  "PO #",
  "Part #",
  "COMMENTS",
] as const;

const BODY_MARKERS = ["Customer Name", "Date Requested", "Pick Up Location", "Unit #", "PO #"] as const;

/**
 * The form is a table of four cells per row. Its text part puts a row on one line, with the
 * tabs between cells expanded to spaces, so these labels are also read inside a line. City
 * and State are left out: they are common words in a place name.
 */
const INLINE = LABELS.filter((l) => l !== "City" && l !== "State");

/** The service list the form repeats in some cells (`["DPF Cleaning "] Manufacturer`). */
const SERVICE_LIST = /\[\s*"[^\]]*"\s*\]/g;
/** Links a mail app adds to a quoted form: `400 Example Rd<https://maps...>`, `0424118850<tel:...>`. */
const LINKS = /<(?:https?|tel|mailto):[^>\s]*>/gi;

type Service = { re: RegExp; item: (name: string) => TemplateItem };
const svc = (sku: string, component: Component) => (name: string): TemplateItem => ({
  description: name,
  partNumber: null,
  sku,
  qty: 1,
  component,
  service: true,
});

/** The services the form offers, as CDS catalog items. */
const SERVICES: Service[] = [
  { re: /^DPF Cleaning\b/i, item: svc("SVC-DPF", "DPF") },
  { re: /^DOC Cleaning\b/i, item: svc("SVC-DOC", "DOC") },
  { re: /^SCR Cleaning\b/i, item: svc("SVC-SCR", "SCR") },
  {
    re: /^EGR Cooler Cleaning\b/i,
    item: (name) => ({ ...svc("SVC-EGR", "EGR")(name), returnToLocation: /return to my location/i.test(name) }),
  },
  {
    re: /\bClamps?\s+(?:and|&)\s+Gaskets?\b/i,
    item: (name) => ({
      description: name,
      partNumber: null,
      qty: 1,
      component: /^DOC\b/i.test(name) ? "DOC" : "DPF",
      service: false,
      kit: true,
    }),
  },
];
const BODY_SERVICES = /\b(?:DPF Cleaning|DOC Cleaning|SCR Cleaning|EGR Cooler Cleaning(?:\s*\(Please return to my location\))?|(?:DPF|DOC) Clamps and Gaskets)\b/gi;

/** The bracketed service list: `["DPF Cleaning ","DPF Clamps and Gaskets "]`. */
function serviceNames(list: string): string[] {
  try {
    const parsed: unknown = JSON.parse(list);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
  } catch {
    // not JSON: read the quoted names, or the plain text
  }
  const quoted = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
  return quoted.length ? quoted : [list.replace(/^\[|\]$/g, "").trim()].filter(Boolean);
}

export function isRyder(subject: string, text: string): boolean {
  return SUBJECT.test(subject) && countLabels(text, BODY_MARKERS) >= 3;
}

export function parseRyder(subject: string, text: string): TemplateResult | null {
  const s = subject.match(SUBJECT);
  if (!s) return null;
  // The service list repeated in a cell, and links a mail app added, are not part of a value.
  const v = readLabels(text.replace(SERVICE_LIST, " ").replace(LINKS, ""), LABELS, ["COMMENTS"], { inline: INLINE, stacked: true });
  const warnings: string[] = [];

  const names = serviceNames(s[3]);
  for (const m of text.matchAll(BODY_SERVICES)) if (!names.some((n) => n.toLowerCase() === m[0].toLowerCase())) names.push(m[0]);
  const items: TemplateItem[] = [];
  for (const name of names) {
    const service = SERVICES.find((x) => x.re.test(name));
    if (!service) {
      items.push({ description: name, partNumber: null, qty: 1, component: null, service: true });
      continue;
    }
    const item = service.item(name);
    // The same service in the subject and the body is one line.
    if (!items.some((i) => (i.sku && i.sku === item.sku) || (i.kit && item.kit && i.component === item.component))) items.push(item);
  }
  const partNumber = v["Part #"];
  for (const item of items) if (item.kit) item.partNumber = partNumber;

  const po = v["PO #"];
  if (po && !/^\d{10}$/.test(po.replace(/\s/g, ""))) warnings.push(`Ryder PO ${po} is not 10 digits: check the PO.`);
  // A ZIP that lost its leading zero ("7074" for 07074).
  const zip = v.ZIP && /^\d{4}$/.test(v.ZIP) ? `0${v.ZIP}` : v.ZIP;
  const cityLine =
    v["Ship to City, State, ZIP"] ??
    (v["Ship to City, State"] ? [v["Ship to City, State"], zip].filter(Boolean).join(" ") : null) ??
    ([v.City, v.State, zip].filter(Boolean).join(", ") || null);
  const address = [v["Pick Up Address"], cityLine].filter(Boolean).join(", ") || null;
  const returnToLocation = items.some((i) => i.returnToLocation);

  return {
    template: "ryder",
    customer: { codes: ["RYDER"], names: ["Ryder"], label: v["Customer Name"] ?? "Ryder" },
    fields: {
      ...present({
        location_number: s[1].replace(/^0+(?=\d)/, ""),
        location_name: v["Pick Up Location"] ?? (s[2].trim() || null),
        location_address: address,
        unit_number: v["Unit #"],
        po_number: po?.replace(/\s/g, "") ?? null,
        requested_date: isoDate(v["Date Requested"]),
        order_type: v["Order Type"],
        region: v.Region,
        serial_number: v["Serial #"],
        manufacturer: v.Manufacturer,
        part_number: partNumber,
        comments: v.COMMENTS,
        mileage: miles(v.Miles),
      }),
      ...(returnToLocation ? { return_to_location: true } : {}),
      fulfillment: "pickup",
    },
    items,
    warnings,
  };
}
