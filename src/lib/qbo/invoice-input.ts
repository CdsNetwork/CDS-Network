import "server-only";
import { one } from "@/components/cds-wo/util";
import type { createClient } from "@/lib/supabase/server";
import {
  buildInvoicePayload,
  type BuildResult,
  type ComponentResult,
  type ComponentType,
  type CustomerAlias,
  type CustomerMapping,
  type InvoiceComponent,
  type InvoiceLine,
  type InvoiceLocation,
  type InvoiceRefs,
  type InvoiceWorkOrder,
  type ItemMapping,
  type ItemMappings,
  type MeasurementMappings,
  type TaxClass,
} from "./invoice";
import { itemDescriptionKey, type InvoiceTarget } from "./invoice-qbo";
import { locationSiteNumber } from "./sub-customer";
import { pendingQbInvoice, type InvoiceSyncRow, type PendingQbInvoice } from "./pending";

type Supabase = Awaited<ReturnType<typeof createClient>>;
type MaybeOne<T> = T | T[] | null;

export type InvoiceState = {
  status: string;
  qbInvoiceId: string | null;
  qbInvoiceNumber: string | null;
  invoicedAt: string | null;
  /** Created in QuickBooks but not recorded on the work order yet (see ./pending). */
  pendingQb: PendingQbInvoice | null;
  /** What the invoice-time QuickBooks lookups need (sub-customer, custom fields). */
  target: InvoiceTarget;
  result: BuildResult;
};

/**
 * Reads everything the invoice needs as the signed-in CDS user (RLS applies) and builds it.
 * Null when the work order does not exist or is not visible.
 */
export async function loadInvoice(supabase: Supabase, woId: string): Promise<InvoiceState | null> {
  const { data: woData, error } = await supabase
    .from("work_orders")
    .select(
      "id, wo_number, status, market, customer_id, affiliate_id, location_label, po_number, unit_number, customers(name), customer_locations(id, code, location_number, name, address_line1, city, region, postal_code, country)",
    )
    .eq("id", woId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the work order: ${error.message}`);
  if (!woData) return null;
  const wo = woData as unknown as {
    id: string;
    wo_number: number;
    status: string;
    market: string;
    customer_id: string;
    affiliate_id: string | null;
    location_label: string;
    po_number: string | null;
    unit_number: string | null;
    customers: MaybeOne<{ name: string }>;
    customer_locations: MaybeOne<{
      id: string;
      code: string;
      location_number: string | null;
      name: string;
      address_line1: string | null;
      city: string | null;
      region: string | null;
      postal_code: string | null;
      country: string | null;
    }>;
  };

  const [internalRes, billingRes, linesRes, customerMapRes, componentsRes, measurementRes, syncRes, refs] = await Promise.all([
    supabase
      .from("work_order_internal")
      .select("tax_parts, tax_labor, tax_shipping, qb_invoice_id, qb_invoice_number, invoiced_at")
      .eq("work_order_id", woId)
      .maybeSingle(),
    supabase.from("customer_billing").select("tax_exempt").eq("customer_id", wo.customer_id).maybeSingle(),
    supabase
      .from("work_order_lines")
      .select("catalog_item_id, qty, description, catalog_items(sku, name), work_order_line_pricing(customer_unit_price, tax_class)")
      .eq("work_order_id", woId)
      .order("created_at"),
    supabase.from("qbo_customer_map").select("qbo_customer_id, qbo_display_name").eq("customer_id", wo.customer_id).maybeSingle(),
    supabase
      .from("work_order_components")
      .select(
        "seq, component_type, manufacturer, part_number, serial_number, dp_before, dp_after, weight_before_g, weight_after_g, weight_removed_g, result",
      )
      .eq("work_order_id", woId)
      .order("seq"),
    supabase
      .from("qbo_measurement_map")
      .select("customer_id, component_type, qbo_item_id, qbo_item_name")
      .or(`customer_id.is.null,customer_id.eq.${wo.customer_id}`),
    supabase
      .from("integration_sync")
      .select("status, external_id, error, at")
      .eq("system", "quickbooks")
      .eq("entity", "invoice")
      .eq("entity_id", woId)
      .eq("status", "ok")
      .order("at", { ascending: false })
      .limit(5),
    loadRefs(supabase, wo.customer_id, wo.affiliate_id),
  ]);
  for (const r of [internalRes, billingRes, linesRes, customerMapRes, componentsRes, measurementRes, syncRes]) {
    if (r.error) throw new Error(`Could not read the invoice details: ${r.error.message}`);
  }

  const internal = internalRes.data as {
    tax_parts: boolean;
    tax_labor: boolean;
    tax_shipping: boolean;
    qb_invoice_id: string | null;
    qb_invoice_number: string | null;
    invoiced_at: string | null;
  } | null;
  const rawLines = (linesRes.data ?? []) as unknown as {
    catalog_item_id: string;
    qty: number | string;
    description: string | null;
    catalog_items: MaybeOne<{ sku: string; name: string }>;
    work_order_line_pricing: MaybeOne<{ customer_unit_price: number | string; tax_class: TaxClass }>;
  }[];
  const itemIds = [...new Set(rawLines.map((l) => l.catalog_item_id))];

  const [itemMapRes, aliasRes, descriptionRes] = itemIds.length
    ? await Promise.all([
        // Every row for these items: this customer's, the ones for all customers, and (only
        // to explain a missing link) other customers'.
        supabase.from("qbo_item_map").select("customer_id, catalog_item_id, qbo_item_id, qbo_item_name").in("catalog_item_id", itemIds),
        supabase
          .from("customer_item_aliases")
          .select("catalog_item_id, customer_part_number, customer_description")
          .eq("customer_id", wo.customer_id)
          .in("catalog_item_id", itemIds),
        // The invoice text per QuickBooks item (a handful of rows).
        supabase.from("qbo_item_descriptions").select("qbo_item_name, description"),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  if (itemMapRes.error) throw new Error(`Could not read the item mappings: ${itemMapRes.error.message}`);
  if (aliasRes.error) throw new Error(`Could not read the customer part numbers: ${aliasRes.error.message}`);
  if (descriptionRes.error) throw new Error(`Could not read the QuickBooks item descriptions: ${descriptionRes.error.message}`);
  const descriptions = new Map<string, string>();
  for (const d of (descriptionRes.data ?? []) as { qbo_item_name: string; description: string }[]) {
    descriptions.set(itemDescriptionKey(d.qbo_item_name), d.description);
  }

  const itemMap: ItemMappings = { customer: {}, default: {}, otherCustomers: {} };
  for (const m of (itemMapRes.data ?? []) as {
    customer_id: string | null;
    catalog_item_id: string;
    qbo_item_id: string;
    qbo_item_name: string;
  }[]) {
    const mapping: ItemMapping = {
      qboItemId: m.qbo_item_id,
      qboItemName: m.qbo_item_name,
      invoiceDescription: descriptions.get(itemDescriptionKey(m.qbo_item_name)) ?? null,
    };
    if (m.customer_id === null) itemMap.default[m.catalog_item_id] = mapping;
    else if (m.customer_id === wo.customer_id) itemMap.customer[m.catalog_item_id] = mapping;
    else itemMap.otherCustomers![m.catalog_item_id] = true;
  }
  const measurementMap: MeasurementMappings = { customer: {}, default: {} };
  for (const m of (measurementRes.data ?? []) as {
    customer_id: string | null;
    component_type: ComponentType;
    qbo_item_id: string;
    qbo_item_name: string;
  }[]) {
    const target = m.customer_id === null ? measurementMap.default : m.customer_id === wo.customer_id ? measurementMap.customer : null;
    if (target) target[m.component_type] = { qboItemId: m.qbo_item_id, qboItemName: m.qbo_item_name };
  }
  const num = (v: number | string | null) => (v === null ? null : Number(v));
  const components: InvoiceComponent[] = (
    (componentsRes.data ?? []) as {
      seq: number;
      component_type: ComponentType;
      manufacturer: string | null;
      part_number: string | null;
      serial_number: string | null;
      dp_before: number | string | null;
      dp_after: number | string | null;
      weight_before_g: number | string | null;
      weight_after_g: number | string | null;
      weight_removed_g: number | string | null;
      result: ComponentResult | null;
    }[]
  ).map((c) => ({
    seq: c.seq,
    componentType: c.component_type,
    manufacturer: c.manufacturer,
    partNumber: c.part_number,
    serialNumber: c.serial_number,
    dpBefore: num(c.dp_before),
    dpAfter: num(c.dp_after),
    weightBeforeG: num(c.weight_before_g),
    weightAfterG: num(c.weight_after_g),
    weightRemovedG: num(c.weight_removed_g),
    result: c.result,
  }));
  const aliases: Record<string, CustomerAlias> = {};
  for (const a of (aliasRes.data ?? []) as {
    catalog_item_id: string;
    customer_part_number: string;
    customer_description: string | null;
  }[]) {
    aliases[a.catalog_item_id] = { partNumber: a.customer_part_number, description: a.customer_description };
  }
  const cm = customerMapRes.data as { qbo_customer_id: string; qbo_display_name: string } | null;
  const customerMap: CustomerMapping | null = cm ? { qboCustomerId: cm.qbo_customer_id, qboDisplayName: cm.qbo_display_name } : null;

  const loc = one(wo.customer_locations);
  const location: InvoiceLocation | null = loc
    ? {
        label: `${loc.code} ${loc.name}`,
        addressLine1: loc.address_line1,
        city: loc.city,
        region: loc.region,
        postalCode: loc.postal_code,
        country: loc.country,
      }
    : null;

  const workOrder: InvoiceWorkOrder = {
    id: wo.id,
    woNumber: wo.wo_number,
    market: wo.market,
    customerName: one(wo.customers)?.name ?? "This customer",
    poNumber: wo.po_number,
    unitNumber: wo.unit_number,
    taxParts: internal?.tax_parts ?? false,
    taxLabor: internal?.tax_labor ?? false,
    taxShipping: internal?.tax_shipping ?? false,
    customerTaxExempt: (billingRes.data as { tax_exempt: boolean } | null)?.tax_exempt ?? false,
  };
  const lines: InvoiceLine[] = rawLines.map((l) => {
    const item = one(l.catalog_items);
    const p = one(l.work_order_line_pricing);
    return {
      catalogItemId: l.catalog_item_id,
      sku: item?.sku ?? "Item",
      name: item?.name ?? "",
      description: l.description,
      qty: Number(l.qty),
      customerUnitPrice: p ? Number(p.customer_unit_price) : null,
      taxClass: p?.tax_class ?? "exempt",
    };
  });

  return {
    status: wo.status,
    qbInvoiceId: internal?.qb_invoice_id ?? null,
    qbInvoiceNumber: internal?.qb_invoice_number ?? null,
    invoicedAt: internal?.invoiced_at ?? null,
    pendingQb: internal?.qb_invoice_id ? null : pendingQbInvoice((syncRes.data ?? []) as InvoiceSyncRow[]),
    target: {
      locationId: loc?.id ?? null,
      siteNumber: loc ? locationSiteNumber(loc.location_number, loc.code) : null,
      locationName: loc?.name ?? null,
      city: loc?.city ?? null,
      poNumber: wo.po_number,
      unitNumber: wo.unit_number,
    },
    result: buildInvoicePayload(workOrder, lines, customerMap, itemMap, aliases, location, components, measurementMap, refs),
  };
}

/**
 * The Division of the customer (qbo_customer_division) and the Class of the shop
 * (qbo_affiliate_class). Customers have no parent in the portal (sites are locations), so
 * the work order's customer is the one whose Division applies. Never stops the invoice: a
 * missing row or a failed read leaves the ref off, as before these mappings existed.
 */
async function loadRefs(supabase: Supabase, customerId: string, affiliateId: string | null): Promise<InvoiceRefs> {
  const read = async <T>(table: string, query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T | null> => {
    try {
      const { data, error } = await query;
      if (error) {
        console.error(`${table}: could not read the invoice mapping: ${error.message}`);
        return null;
      }
      return data as T | null;
    } catch (e) {
      console.error(`${table}: could not read the invoice mapping: ${e instanceof Error ? e.message : "unknown error"}`);
      return null;
    }
  };
  const [division, cls] = await Promise.all([
    read<{ qbo_department_id: string }>(
      "qbo_customer_division",
      supabase.from("qbo_customer_division").select("qbo_department_id").eq("customer_id", customerId).maybeSingle(),
    ),
    affiliateId
      ? read<{ qbo_class_id: string }>(
          "qbo_affiliate_class",
          supabase.from("qbo_affiliate_class").select("qbo_class_id").eq("affiliate_id", affiliateId).maybeSingle(),
        )
      : null,
  ]);
  return { departmentId: division?.qbo_department_id ?? null, classId: cls?.qbo_class_id ?? null };
}
