/**
 * The work_order_internal columns the CDS work order page reads (CDS only). Safe on server
 * and client.
 *
 * work_order_internal has two foreign keys to public.profiles: approved_by (who approved the
 * order) and shop_bill_approved_by (20261123100000_shop_bill_approval.sql). A bare
 * profiles(...) embed is then ambiguous and the whole read fails, so the approver is embedded
 * through the approved_by foreign key by name.
 */
export const WO_INTERNAL_COLUMNS =
  "source, review_reason, routing_notes, internal_notes, order_type, customer_region, customer_contact_name, customer_contact_email, customer_contact_phone, approved_at, approved_by, approved_by_name, tax_rate, tax_parts, tax_labor, tax_shipping, tax_jurisdiction, tax_source, ready_to_invoice_at, invoiced_at, qb_invoice_id, qb_invoice_number, qb_tax_total, qb_total, qb_bill_id, shop_shipping_credit, internal_status, profiles:profiles!work_order_internal_approved_by_fkey(full_name)";
