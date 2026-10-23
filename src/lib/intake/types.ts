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
  /** The In-Reply-To header: set on replies within an existing thread. */
  inReplyTo?: string | null;
  /** The CDS inbox the feed delivered the email to (dispatch@, xpo@), when the feed knows it. */
  deliveredTo?: string | null;
};

/** "template": read from a fixed request template (Ryder form, iProcure PO, website form). */
export type FieldSource = "template" | "regex" | "llm" | "location_default" | "none";

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

/**
 * Splits the active catalog into the items intake may propose and the items priced per line
 * (Misc. hardware), which are never proposed but are named in a warning when an email asks
 * for one. The Supabase store and the test fixtures both build their reference with it.
 */
export function splitCatalog(all: CatalogRef[]): Pick<IntakeReference, "catalog" | "perLineItems"> {
  return { catalog: matchableCatalog(all), perLineItems: all.filter((c) => c.price_per_line) };
}
export type AliasRef = { customer_id: string; catalog_item_id: string; customer_part_number: string };

/** Reference data the matcher reads. Locations are loaded per customer (there are many). */
export type IntakeReference = {
  customers: CustomerRef[];
  domains: DomainRef[];
  /** Items intake may propose (never items priced per line). */
  catalog: CatalogRef[];
  /** Items priced per line (Misc. hardware): never proposed, only warned about. */
  perLineItems: CatalogRef[];
  aliases: AliasRef[];
  locationsFor: (customerId: string) => Promise<LocationRef[]>;
  /** The customer's portal price for an item today (override, else fleet price), or null. */
  priceFor?: (customerId: string, catalogItemId: string) => Promise<number | null>;
};

export type CustomerMatch = {
  id: string;
  name: string;
  via: "template" | "sender_domain" | "inbox" | "content" | "llm_name";
  confidence: number;
};
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
  source: "template" | "regex" | "llm";
  confidence: number;
  /** Price written on the customer's PO (iProcure). */
  price?: number | null;
  /** The portal price for this customer on the day, to compare with the PO price. */
  portal_price?: number | null;
  required_date?: string | null;
  taxable?: boolean | null;
  cost_center?: string | null;
  /** EGR cooler to be returned to the customer's location (Ryder form). */
  return_to_location?: boolean;
};

export type TemplateName = "ryder" | "first_student_iprocure" | "website_form";

/** Why an email is not a request: replies, invoices, carrier notices, CDS's own mail and so on. */
export type IgnoreKind = "reply" | "invoice" | "carrier" | "security" | "cds_sent" | "ryder_po" | "forwarding_confirmation";

/** Fields read from the templates (and XPO free text) beyond the original set. */
export type DetailFields = {
  requested_date?: Field<string>;
  order_type?: Field<string>;
  region?: Field<string>;
  mileage?: Field<number>;
  serial_number?: Field<string>;
  manufacturer?: Field<string>;
  part_number?: Field<string>;
  comments?: Field<string>;
  contact_name?: Field<string>;
  contact_email?: Field<string>;
  contact_phone?: Field<string>;
  store_room?: Field<string>;
  pickup_option?: Field<string>;
  filter_options?: Field<string>;
  parts_or_service?: Field<string>;
  cost_center?: Field<string>;
  order_description?: Field<string>;
  location_suffix?: Field<string>;
  return_to_location?: Field<boolean>;
};

/** What the pipeline stores in inbound_emails.parsed. Ids are always matched in code. */
export type ParsedEmail = {
  version: 1;
  is_work_request: boolean;
  ignore_reason: string | null;
  ignore_kind?: IgnoreKind | null;
  /** The request template the email matched; the AI stage runs only when none did. */
  template?: TemplateName | null;
  /** The CDS inbox the email arrived at. */
  mailbox?: string | null;
  /** A Ryder PO issued email noted on the open order with that PO number. */
  po_reference?: { po_number: string; work_order_id: string | null; wo_number: number | null } | null;
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
  } & DetailFields;
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
