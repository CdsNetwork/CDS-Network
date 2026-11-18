-- New from shop orders first on the CDS dashboard (Sarah, CDS, 2026-11-18: "Can we have the
-- 'new from shop' orders bump to the top of the summary page?").
--
-- public.work_order_list (20261113010000_work_order_list_order.sql) gets one more column:
--
-- new_from_shop: the order has shop activity CDS has not opened yet
--   (work_order_shop_activity.is_new, 20261111040000_shop_updates.sql); false when it has no
--   activity row. The dashboard sorts by it first (descending), then by list_rank, newest
--   first and id as before, in the database, so the flagged orders are never cut off by the
--   table's 200-row limit. The CSV export keeps the sheet order (src/components/cds-wo/woFilters.ts).
--
-- The view is dropped and created again rather than replaced: w.* is expanded when the view is
-- created, and a column added to work_orders since would otherwise shift the view's columns.
-- Nothing depends on the view. Everything else is unchanged: list_rank, tracking_search,
-- security_invoker, CDS only, and the grants.

drop view public.work_order_list;

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
  ) as tracking_search,
  exists (
    select 1 from public.work_order_shop_activity a
    where a.work_order_id = w.id and a.is_new
  ) as new_from_shop
from public.work_orders w
where (select private.is_cds());

comment on view public.work_order_list is
  'CDS dashboard work order table: work_orders plus list_rank (status order of the CDS tracking sheet), tracking_search (tracking numbers, no spaces, lower case) and new_from_shop (shop activity CDS has not opened). CDS only.';

-- Grants (20261020000000_explicit_api_grants.sql), the same as public.work_order_financials.
revoke all on table public.work_order_list from public, anon, authenticated, service_role;
grant maintain, select on table public.work_order_list to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_list to service_role;
