/**
 * Invented reference data for the intake tests: customers, sender domains, locations,
 * catalog items and customer part numbers. No real addresses or contacts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AliasRef, CatalogRef, CustomerRef, DomainRef, IntakeReference, LocationRef, NormalizedEmail } from "@/lib/intake/types";
import { validateNormalizedEmail } from "@/lib/intake/email";

export const RYDER = "00000000-0000-4000-8000-00000000a001";
export const FIRST_STUDENT = "00000000-0000-4000-8000-00000000a002";
export const AMAZON = "00000000-0000-4000-8000-00000000a003";

export const customers: CustomerRef[] = [
  { id: RYDER, code: "RYDER", name: "Ryder" },
  { id: FIRST_STUDENT, code: "FIRST_STUDENT", name: "First Student" },
  { id: AMAZON, code: "AMAZON", name: "Amazon" },
];

export const domains: DomainRef[] = [
  { customer_id: RYDER, domain: "ryder.example" },
  { customer_id: FIRST_STUDENT, domain: "firststudent.example" },
];

const loc = (id: string, customer_id: string, code: string, location_number: string | null, name: string, address_raw: string, extra: Partial<LocationRef> = {}): LocationRef => ({
  id: `00000000-0000-4000-8000-0000000b${id}`,
  customer_id,
  code,
  location_number,
  name,
  address_raw,
  city: null,
  region: null,
  postal_code: null,
  fulfillment: "unspecified",
  ...extra,
});

export const locations: LocationRef[] = [
  loc("0424", RYDER, "424-LAKEMONT", "424", "LAKEMONT", "400 Example Rd, Lakemont, PA 15000", { fulfillment: "pickup", region: "PA", postal_code: "15000" }),
  loc("4240", RYDER, "4240-RIVERBEND", "4240", "RIVERBEND", "12 Sample St, Riverbend, TX 75000"),
  loc("0611", RYDER, "611-NORTH HAVEN", "611", "NORTH HAVEN", "61 Demo Ave, North Haven, CT 06000", { fulfillment: "shipping" }),
  loc("0077", RYDER, "77-FAIRVIEW", "77", "FAIRVIEW", "1180 Industrial Pkwy, Fairview, OH 44126", { postal_code: "44126", region: "OH" }),
  loc("0078", RYDER, "78-FAIRVIEW EAST", "78", "FAIRVIEW EAST", "2200 Commerce Dr, Fairview, OH 44126", { postal_code: "44126", region: "OH" }),
  loc("2723", FIRST_STUDENT, "12723M", "12723", "Brookside Transportation", "9 Placeholder Way, Brookside, IL 60000"),
  loc("0418", FIRST_STUDENT, "30418M", "30418", "Maple Grove Depot", "77 Orchard Lane, Maple Grove, MN 55369", { postal_code: "55369" }),
];

const item = (n: string, sku: string, name: string, category: string, oe_cross: string | null = null): CatalogRef => ({
  id: `00000000-0000-4000-8000-0000000c${n}`,
  sku,
  name,
  category,
  oe_cross,
});

export const DPF_CLEAN = item("0001", "SVC-DPF", "DPF Cleaning", "service");
export const DOC_CLEAN = item("0002", "SVC-DOC", "DOC Cleaning", "service");
export const SCR_CLEAN = item("0003", "SVC-SCR", "SCR Cleaning", "service");
export const EGR = item("0004", "SVC-EGR", "EGR Cooler", "service");
export const DPF_OIL = item("0005", "SVC-DPF-OIL", "Oil/Fuel Soaked DPF", "service");
export const BOX_BAKE = item("0006", "SVC-1BOX-BAKE", "One Box Bake & Clean", "service");
export const DPF_GASKET = item("0007", "CDS-G-1051", "DPF Inlet Gasket", "gasket", "A0001234 / 2871999");
export const VBAND_CLAMP = item("0008", "CDS-C-4000", "V-Band Clamp 4in", "clamp");

export const catalog: CatalogRef[] = [DPF_CLEAN, DOC_CLEAN, SCR_CLEAN, EGR, DPF_OIL, BOX_BAKE, DPF_GASKET, VBAND_CLAMP];

export const aliases: AliasRef[] = [
  { customer_id: FIRST_STUDENT, catalog_item_id: DPF_CLEAN.id, customer_part_number: "FS-DPF-0097" },
  { customer_id: FIRST_STUDENT, catalog_item_id: DOC_CLEAN.id, customer_part_number: "FS-DOC-0044" },
  { customer_id: FIRST_STUDENT, catalog_item_id: DPF_GASKET.id, customer_part_number: "FS-GSK-1201" },
  { customer_id: FIRST_STUDENT, catalog_item_id: VBAND_CLAMP.id, customer_part_number: "FS-CLP-0310" },
];

export function reference(): IntakeReference {
  return {
    customers,
    domains,
    catalog,
    aliases,
    locationsFor: async (customerId) => locations.filter((l) => l.customer_id === customerId),
  };
}

export const loc0424 = locations[0];
export const loc0611 = locations[2];
export const loc0077 = locations[3];
export const locFs12723 = locations[5];
export const locFs30418 = locations[6];

export function fixture(name: string): NormalizedEmail {
  const raw: unknown = JSON.parse(readFileSync(join(__dirname, `${name}.json`), "utf8"));
  const result = validateNormalizedEmail(raw);
  if (!result.ok) throw new Error(`fixture ${name}: ${result.error}`);
  return result.value;
}

export const FIXTURES = [
  "ryder-dpf-pickup",
  "first-student-parts",
  "forwarded-chain",
  "no-location-number",
  "not-work-request",
  "duplicate-message-id",
  "first-student-html-portal",
] as const;
