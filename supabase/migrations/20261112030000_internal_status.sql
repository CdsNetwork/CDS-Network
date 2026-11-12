-- CDS-only internal status (Sarah, CDS dispatch, 2026-11-12).
--
-- Why: most of what CDS tracks on an order happens outside the portal, in email (the ETA was
-- sent, the invoice is ready or sent, nothing more to do), so CDS sets it by hand on the work
-- order page and sees it in the CDS work order list, under the status.
--
-- work_order_internal.internal_status: one of six values, or null (blank, the default). It
-- never changes the order's status and nothing sets it automatically.
--
-- CDS only. It lives on work_order_internal, not on work_orders, because shops read their own
-- work_orders rows (policy shop_read): a column there would be readable by the shop.
-- work_order_internal has only the cds_all policy, so a shop login can neither read nor
-- change it. CDS sets it through the app (the work order page logs a CDS-only event).
-- Grants are unchanged (the table's existing grants cover the new column).

alter table public.work_order_internal
  add column internal_status text
    constraint work_order_internal_internal_status_check
    check (internal_status in ('eta_sent', 'condemned', 'invoice_ready', 'invoice_sent', 'no_action_needed', 'closed'));

comment on column public.work_order_internal.internal_status is
  'CDS-only status set by hand (ETA Sent, Condemned, Invoice Ready, Invoice Sent, No Action Needed, Closed); null is blank. Never changes work_orders.status.';
