/**
 * The website (Wix) fleet request form: "Website FORM SUBMISSION: Fleet Requests - <Fleet>".
 * Sent by the website on CDS's behalf, so the sender says nothing about the customer: the
 * fleet comes from the subject.
 */
import type { Fulfillment } from "../types";
import { componentsIn, countLabels, miles, present, readLabels, type TemplateItem, type TemplateResult } from "./common";

const SUBJECT = /\bWebsite FORM SUBMISSION:\s*Fleet Requests?\s*-\s*(.+?)\s*$/i;
const LABELS = [
  "Name",
  "Store Room #",
  "Shop Phone #",
  "Shop Email",
  "PC Email",
  "Location Address",
  "Pickup Address",
  "Pickup / Delivery Options",
  "Mileage",
  "PO #",
  "VIN #",
  "Part #",
  "Filter Options",
  "Parts or Service",
  "Comments",
] as const;
const SECTIONS = ["CONTACT INFO", "ADDRESS & PICKUP INFORMATION", "JOB DETAILS"] as const;

export function isWebsiteForm(subject: string, text: string): boolean {
  return SUBJECT.test(subject) && countLabels(text, SECTIONS) >= 2;
}

function fulfillmentOf(option: string | null): Fulfillment | undefined {
  if (!option) return undefined;
  if (/\bship|\bmail\b|\bsend\b|\bbox\b|\blabel\b/i.test(option)) return "shipping";
  if (/\bpick\s?-?\s?up\b/i.test(option)) return "pickup";
  return undefined;
}

export function parseWebsiteForm(subject: string, text: string): TemplateResult {
  const fleet = subject.match(SUBJECT)?.[1] ?? "";
  const v = readLabels(text, LABELS);
  const warnings: string[] = [];

  const components = componentsIn(v["Filter Options"]);
  const kind = v["Parts or Service"] ?? "";
  const wantsService = /\bservice|\bclean/i.test(kind) || (!kind && components.length > 0);
  const wantsParts = /\bpart/i.test(kind);
  const items: TemplateItem[] = [];
  if (wantsService) {
    for (const c of components) items.push({ description: `${c} cleaning`, partNumber: null, qty: 1, component: c, service: true });
  }
  if (wantsParts && v["Part #"]) {
    items.push({ description: v["Part #"], partNumber: v["Part #"], qty: 1, component: null, service: false });
  }

  const pickup = v["Pickup Address"];
  const location = v["Location Address"];
  if (pickup && location && pickup.toLowerCase() !== location.toLowerCase() && !/^same\b/i.test(pickup)) {
    warnings.push(`Pickup address differs from the location address: ${pickup}.`);
  }

  return {
    template: "website_form",
    customer: { codes: [fleet.toUpperCase().replace(/[^A-Z0-9]+/g, "_")], names: [fleet], label: fleet },
    fields: {
      ...present({
        contact_name: v.Name,
        store_room: v["Store Room #"],
        contact_phone: v["Shop Phone #"],
        contact_email: (v["Shop Email"] ?? v["PC Email"])?.toLowerCase() ?? null,
        location_address: location ?? pickup,
        pickup_address: pickup,
        pickup_option: v["Pickup / Delivery Options"],
        mileage: miles(v.Mileage),
        po_number: v["PO #"],
        vin: v["VIN #"]?.toUpperCase().replace(/\s/g, "") ?? null,
        part_number: v["Part #"],
        filter_options: v["Filter Options"],
        parts_or_service: v["Parts or Service"],
        comments: v.Comments,
      }),
      ...(fulfillmentOf(v["Pickup / Delivery Options"]) ? { fulfillment: fulfillmentOf(v["Pickup / Delivery Options"]) } : {}),
    },
    items,
    warnings,
  };
}
