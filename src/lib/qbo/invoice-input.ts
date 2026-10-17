import "server-only";
import { one } from "@/components/cds-wo/util";
import type { createClient } from "@/lib/supabase/server";
import {
  buildInvoicePayload,
  type BuildResult,
  type ComponentResult,
  type ComponentType,
  type CustomerMapping,
  type InvoiceComponent,
  type InvoiceLine,
  type InvoiceLocation,
  type InvoiceWorkOrder,
  type ItemMapping,
  type ItemMappings,
  type MeasurementMappings,
  type TaxClass,
} from "./invoice";

type Supabase = Awaited<ReturnType<typeof createClient>>;
type MaybeOne<T> = T | T[] | null;

export type InvoiceState = {
  status: string;
  qbInvoiceId: string | null;
  qbInvoiceNumber: string | null;
  invoicedAt: string | null;
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
      "id, wo_number, status, market, customer_id, location_label, po_number, unit_number, customers(name), customer_locations(code, name, address_line1, city, region, postal_code, country)",
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
    location_label: string;
    po_number: string | null;
    unit_number: string | null;
    customers: MaybeOne<{ name: string }>;
    customer_locations: MaybeOne<{
      code: string;
      name: string;
      address_line1: string | null;
      city: string | null;
      region: string | null;
      postal_code: string | null;
      country: string | null;
    }>;
  };

  const [internalRes, billingRes, linesRes, customerMapRes, componentsRes, measurementRes] = await Promise.all([
    supabase
      .from("work_order_internal")
      .select("tax_parts, tax_labor, tax_shipping, qb_invoice_id, qb_invoice_number, invoiced_at")
      .eq("work_order_id", woId)
      .maybeSingle(),
    supabase.from("customer_billing").select("tax_exempt").eq("customer_id", wo.customer_id).maybeSingle(),
    supabase
      .from("work_order_lines")
      .select("catalog_item_id, qty, catalog_items(sku, name), work_order_line_pricing(customer_unit_price, tax_class)")
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
  ]);
  for (const r of [internalRes, billingRes, linesRes, customerMapRes, componentsRes, measurementRes]) {
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
    catalog_items: MaybeOne<{ sku: string; name: string }>;
    work_order_line_pricing: MaybeOne<{ customer_unit_price: number | string; tax_class: TaxClass }>;
  }[];
  const itemIds = [...new Set(rawLines.map((l) => l.catalog_item_id))];

  const [itemMapRes, aliasRes] = itemIds.length
    ? await Promise.all([
        // Every row for these items: this customer's, the ones for all customers, and (only
        // to explain a missing link) other customers'.
        supabase.from("qbo_item_map").select("customer_id, catalog_item_id, qbo_item_id, qbo_item_name").in("catalog_item_id", itemIds),
        supabase
          .from("customer_item_aliases")
          .select("catalog_item_id, customer_part_number")
          .eq("customer_id", wo.customer_id)
          .in("catalog_item_id", itemIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (itemMapRes.error) throw new Error(`Could not read the item mappings: ${itemMapRes.error.message}`);
  if (aliasRes.error) throw new Error(`Could not read the customer part numbers: ${aliasRes.error.message}`);

  const itemMap: ItemMappings = { customer: {}, default: {}, otherCustomers: {} };
  for (const m of (itemMapRes.data ?? []) as {
    customer_id: string | null;
    catalog_item_id: string;
    qbo_item_id: string;
    qbo_item_name: string;
  }[]) {
    const mapping: ItemMapping = { qboItemId: m.qbo_item_id, qboItemName: m.qbo_item_name };
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
  const aliases: Record<string, string> = {};
  for (const a of (aliasRes.data ?? []) as { catalog_item_id: string; customer_part_number: string }[]) {
    aliases[a.catalog_item_id] = a.customer_part_number;
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
    result: buildInvoicePayload(workOrder, lines, customerMap, itemMap, aliases, location, components, measurementMap),
  };
}
