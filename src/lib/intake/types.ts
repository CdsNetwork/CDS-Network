/** Shared types for the email intake pipeline. Safe on server and client (no secrets, no I/O). */

export type EmailAttachment = { filename: string; contentType: string | null; size: number | null };

/**
 * One inbound email in the source-neutral shape every feed is converted to (webhook from a
 * forwarding service, Gmail push, Resend inbound, or the paste form on /cds/intake).
 */
export type NormalizedEmail = {
  /** The RFC 5322 Message-ID (or the provider's own id). Each id is processed once. */
  messageId: string;
  /** Raw From header, for example `Jane Doe <jane@fleet.example>`. */
  from: string;
  to: string[];
  subject: string;
  /** ISO 8601. */
  receivedAt: string;
  text: string | null;
  html: string | null;
  attachments: EmailAttachment[];
};

export type FieldSource = "regex" | "llm" | "location_default" | "none";

export type Field<T> = { value: T | null; source: FieldSource; confidence: number };

export type Fulfillment = "pickup" | "shipping" | "unspecified";

export type Component = "DPF" | "DOC" | "SCR" | "EGR" | "other";

export type CustomerRef = { id: string; code: string; name: string };
export type DomainRef = { customer_id: string; domain: string };
export type LocationRef = {
  id: string;
  customer_id: string;
  code: string;
  location_number: string | null;
  name: string;
  address_raw: string;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  fulfillment: string;
};
export type CatalogRef = {
  id: string;
  sku: string;
  name: string;
  category: string;
  oe_cross: string | null;
  /** Priced per line from the shop's invoice (Misc. hardware): never proposed by intake. */
  price_per_line?: boolean;
};

/** The catalog items intake may propose: everything except items priced per line. */
export function matchableCatalog(catalog: CatalogRef[]): CatalogRef[] {
  return catalog.filter((c) => !c.price_per_line);
}
export type AliasRef = { customer_id: string; catalog_item_id: string; customer_part_number: string };

/** Reference data the matcher reads. Locations are loaded per customer (there are many). */
export type IntakeReference = {
  customers: CustomerRef[];
  domains: DomainRef[];
  catalog: CatalogRef[];
  aliases: AliasRef[];
  locationsFor: (customerId: string) => Promise<LocationRef[]>;
};

export type CustomerMatch = { id: string; name: string; via: "sender_domain" | "content" | "llm_name"; confidence: number };
export type LocationMatch = {
  id: string;
  code: string;
  name: string;
  via: "location_number" | "address" | "name";
  confidence: number;
};
export type ItemMatch = {
  description: string;
  part_number: string | null;
  qty: number;
  catalog_item_id: string | null;
  sku: string | null;
  name: string | null;
  via: "customer_alias" | "sku" | "oe_cross" | "name" | "none";
  source: "regex" | "llm";
  confidence: number;
};

/** What the pipeline stores in inbound_emails.parsed. Ids are always matched in code. */
export type ParsedEmail = {
  version: 1;
  is_work_request: boolean;
  ignore_reason: string | null;
  original_sender: string | null;
  llm: { used: boolean; model: string | null; error: string | null };
  fields: {
    po_number: Field<string>;
    unit_number: Field<string>;
    vin: Field<string>;
    location_number: Field<string>;
    location_name: Field<string>;
    location_address: Field<string>;
    fulfillment: Field<Fulfillment>;
    requested_work: Field<string>;
    notes: Field<string>;
  };
  customer: CustomerMatch | null;
  customer_candidates: { id: string; name: string }[];
  location: LocationMatch | null;
  location_candidates: { id: string; code: string; name: string }[];
  items: ItemMatch[];
  request_type: "service" | "parts_only";
  confidence: number;
  confidence_label: "high" | "medium" | "low";
  warnings: string[];
};
