-- The CDS dashboard's work order table in the order of CDS's Google tracking sheet (Sarah,
-- CDS dispatch, 2026-11-13), and search by tracking number.
--
-- public.work_order_list is work_orders plus two columns, and the dashboard table and its CSV
-- export read it instead of work_orders:
--
-- list_rank: most pressing first.
--    1 Pending Review
--    2 Question Pending (work_order_questions.question_pending), unless invoiced or cancelled
--    3 Declined by Shop
--    4 Awaiting Acceptance, 5 Accepted, 6 Picked up, 7 In Process, 8 Completed, 9 Delivered,
--   10 Ready to Invoice
--   11 Condemned: a component with result 'condemned', unless invoiced or cancelled
--   12 Invoiced
--   13 Cancelled
--   Pending Review and Question Pending come before Declined and Condemned: an order that is
--   both shows in the higher group. The table sorts by list_rank, then newest first, in the
--   database, so the order holds across the export's pages.
--
-- tracking_search: the tracking numbers of the order's shipments (either direction), without
--   spaces and in lower case, separated by a space. The search box matches it with the search
--   text stripped of spaces, so "1Z 999 AA1" finds 1Z999AA1.
--
-- Same access as public.work_order_financials: security_invoker (the caller's RLS applies to
-- every table read) and CDS only, so a shop reads no rows (list_rank would otherwise tell a
-- shop that CDS has a question pending). Only work_orders is in the FROM clause, so the Data
-- API embeds (customers, affiliates, work_order_internal, work_order_components, ...) work as
-- they do on work_orders.

create view public.work_order_list with (security_invoker = true) as
select
  w.*,
  (case
    when w.status = 'pending_review' then 1
    when w.status not in ('invoiced', 'cancelled') and exists (
      select 1 from public.work_order_questions q
      where q.work_order_id = w.id and q.question_pending
    ) then 2
    when w.status = 'rejected_by_affiliate' then 3
    when w.status not in ('invoiced', 'cancelled') and exists (
      select 1 from public.work_order_components c
      where c.work_order_id = w.id and c.result = 'condemned'
    ) then 11
    when w.status = 'awaiting_acceptance' then 4
    when w.status = 'accepted' then 5
    when w.status = 'picked_up' then 6
    when w.status = 'in_process' then 7
    when w.status = 'completed' then 8
    when w.status = 'delivered' then 9
    when w.status = 'ready_to_invoice' then 10
    when w.status = 'invoiced' then 12
    when w.status = 'cancelled' then 13
    else 14
  end)::smallint as list_rank,
  (
    select string_agg(lower(regexp_replace(s.tracking_number, '\s', '', 'g')), ' ')
    from public.shipments s
    where s.work_order_id = w.id and s.tracking_number is not null
  ) as tracking_search
from public.work_orders w
where (select private.is_cds());

comment on view public.work_order_list is
  'CDS dashboard work order table: work_orders plus list_rank (status order of the CDS tracking sheet) and tracking_search (tracking numbers, no spaces, lower case). CDS only.';

-- Grants (20261020000000_explicit_api_grants.sql), the same as public.work_order_financials.
revoke all on table public.work_order_list from public, anon, authenticated, service_role;
grant maintain, select on table public.work_order_list to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_list to service_role;
