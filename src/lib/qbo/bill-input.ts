import type { SupabaseClient } from "@supabase/supabase-js";
import { loadShopDeductions } from "@/lib/shop-deductions";
import { BILL_SETTING_KEY, parseBillSetting, type BillInputs, type BillLine, type BillRecord } from "./bill";
import { toItemMappings } from "./invoice";

/**
 * Reads what the shop's bill needs (./bill) for one work order. Works with the signed-in CDS
 * user's client (the work order page, the Approve button) and with the service role (the
 * bill run itself). Null when the work order does not exist or is not visible.
 */

type MaybeOne<T> = T | T[] | null;
const one = <T>(v: MaybeOne<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

export async function loadBillInputs(
  db: SupabaseClient,
  woId: string,
): Promise<{ inputs: BillInputs; record: BillRecord | null } | null> {
  const { data: woData, error } = await db
    .from("work_orders")
    .select(
      "id, wo_number, status, completed_at, affiliate_invoice_ref, po_number, unit_number, customer_id, affiliate_id, customers(name), affiliates(display_name, is_in_house)",
    )
    .eq("id", woId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the work order: ${error.message}`);
  if (!woData) return null;
  const wo = woData as unknown as {
    id: string;
    wo_number: number;
    status: string;
    completed_at: string | null;
    affiliate_invoice_ref: string | null;
    po_number: string | null;
    unit_number: string | null;
    customer_id: string;
    affiliate_id: string | null;
    customers: MaybeOne<{ name: string }>;
    affiliates: MaybeOne<{ display_name: string; is_in_house: boolean }>;
  };
  const shop = one(wo.affiliates);
  const affiliateId = wo.affiliate_id ?? "00000000-0000-0000-0000-000000000000";

  const [linesRes, vendorRes, classRes, settingRes, billRes, incomeRes, cogsRes, approvalRes, deductions] = await Promise.all([
    db.from("work_order_lines").select("catalog_item_id, qty, shop_unit_rate, description, catalog_items(sku, name)").eq("work_order_id", woId).order("created_at"),
    db.from("qbo_affiliate_vendor").select("qbo_vendor_id, qbo_vendor_name, linked_at").eq("affiliate_id", affiliateId).maybeSingle(),
    db.from("qbo_affiliate_class").select("qbo_class_id").eq("affiliate_id", affiliateId).maybeSingle(),
    db.from("app_settings").select("value").eq("key", BILL_SETTING_KEY).maybeSingle(),
    db
      .from("qbo_shop_bills")
      .select("status, qb_bill_id, qb_bill_number, qb_total, error, claimed_at, bill_created_at")
      .eq("work_order_id", woId)
      .maybeSingle(),
    db.from("qbo_customer_division").select("qbo_department_name").eq("customer_id", wo.customer_id).maybeSingle(),
    db.from("qbo_customer_cogs_division").select("qbo_department_id, qbo_department_name").eq("customer_id", wo.customer_id).maybeSingle(),
    // CDS's approval of the bill (20261123100000_shop_bill_approval.sql), CDS only.
    db.from("work_order_internal").select("shop_bill_approved_at").eq("work_order_id", woId).maybeSingle(),
    loadShopDeductions(db, woId),
  ]);
  for (const r of [linesRes, vendorRes, classRes, settingRes, billRes, incomeRes, cogsRes, approvalRes]) {
    if (r.error) throw new Error(`Could not read the shop bill details: ${r.error.message}`);
  }

  const rawLines = (linesRes.data ?? []) as unknown as {
    catalog_item_id: string;
    qty: number | string;
    shop_unit_rate: number | string | null;
    description: string | null;
    catalog_items: MaybeOne<{ sku: string; name: string }>;
  }[];
  const lines: BillLine[] = rawLines.map((l) => {
    const item = one(l.catalog_items);
    return {
      catalogItemId: l.catalog_item_id,
      sku: item?.sku ?? "",
      name: item?.name ?? "",
      description: l.description ?? null,
      qty: Number(l.qty),
      shopUnitRate: num(l.shop_unit_rate),
    };
  });

  // The QuickBooks item of each line, as the customer's invoice uses it (./invoice-input).
  const itemIds = [...new Set(rawLines.map((l) => l.catalog_item_id))];
  const itemMapRes = itemIds.length
    ? await db.from("qbo_item_map").select("customer_id, catalog_item_id, qbo_item_id, qbo_item_name").in("catalog_item_id", itemIds)
    : { data: [], error: null };
  if (itemMapRes.error) throw new Error(`Could not read the item mappings: ${itemMapRes.error.message}`);
  const cogs = cogsRes.data as { qbo_department_id: string; qbo_department_name: string } | null;
  const vendor = vendorRes.data as { qbo_vendor_id: string; qbo_vendor_name: string; linked_at: string | null } | null;
  const bill = billRes.data as {
    status: BillRecord["status"];
    qb_bill_id: string | null;
    qb_bill_number: string | null;
    qb_total: number | string | null;
    error: string | null;
    claimed_at: string | null;
    bill_created_at: string | null;
  } | null;

  return {
    inputs: {
      workOrder: {
        id: wo.id,
        woNumber: wo.wo_number,
        status: wo.status,
        completedAt: wo.completed_at,
        customerId: wo.customer_id,
        shopInvoiceRef: wo.affiliate_invoice_ref,
        customerName: one(wo.customers)?.name ?? "",
        poNumber: wo.po_number,
        unitNumber: wo.unit_number,
        shopName: shop?.display_name ?? "The shop",
        // CDS's own shop: billed only once linked to a QuickBooks vendor (./bill billState).
        // No shop on the order: never linked (no vendor row), so nothing to bill.
        shopInHouse: !wo.affiliate_id || !!shop?.is_in_house,
      },
      lines,
      deductions,
      vendor: vendor ? { qboVendorId: vendor.qbo_vendor_id, qboVendorName: vendor.qbo_vendor_name, linkedAt: vendor.linked_at } : null,
      setting: parseBillSetting((settingRes.data as { value: unknown } | null)?.value),
      classId: (classRes.data as { qbo_class_id: string } | null)?.qbo_class_id ?? null,
      division: cogs ? { id: cogs.qbo_department_id, name: cogs.qbo_department_name } : null,
      incomeDivisionName: (incomeRes.data as { qbo_department_name: string } | null)?.qbo_department_name ?? null,
      itemMap: toItemMappings(
        (itemMapRes.data ?? []) as { customer_id: string | null; catalog_item_id: string; qbo_item_id: string; qbo_item_name: string }[],
        wo.customer_id,
      ),
      approvedAt: (approvalRes.data as { shop_bill_approved_at: string | null } | null)?.shop_bill_approved_at ?? null,
    },
    record: bill
      ? {
          status: bill.status,
          qbBillId: bill.qb_bill_id,
          qbBillNumber: bill.qb_bill_number,
          qbTotal: num(bill.qb_total),
          error: bill.error,
          claimedAt: bill.claimed_at,
          billCreatedAt: bill.bill_created_at,
        }
      : null,
  };
}
