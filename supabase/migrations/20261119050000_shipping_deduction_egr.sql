-- Shared shipping deduction counts EGR coolers too (CDS, 2026-11-17).
--
-- CDS reported that the shipping credit did not apply to a shipped EGR order (WO-101928).
-- New rule from CDS: EGR coolers on shipped orders get the same $15.00 round trip
-- deduction as filters. So the deduction now counts every component (DPF, DOC, SCR and EGR)
-- recorded by the order's current shop.
--
-- Same view as 20261111030000_shop_filter_shipping_deduction.sql with only that change:
--   * the order's fulfillment is 'shipping' (pickup / local delivery, supplier direct and
--     unspecified orders get nothing);
--   * the order's shop is not CDS's in-house shop (CDS does not bill itself);
--   * filters = every component of the order recorded by its current shop (DPF, DOC, SCR
--     and EGR coolers). The column keeps its name (kind 'filter_shipping', column
--     'filters') so work_order_financials and the app read it unchanged; it is the number
--     of parts shipped;
--   * no row when there are none.
-- The amount per part is still private.shop_shipping_deduction_per_filter().

create or replace view public.work_order_shop_deductions with (security_invoker = true) as
select
  w.id as work_order_id,
  'filter_shipping'::text as kind,
  f.filters::integer as filters,
  (-private.shop_shipping_deduction_per_filter())::numeric(12,2) as unit_amount,
  (-private.shop_shipping_deduction_per_filter() * f.filters)::numeric(12,2) as amount
from public.work_orders w
join public.affiliates a on a.id = w.affiliate_id
cross join lateral (
  select count(*) as filters
  from public.work_order_components c
  where c.work_order_id = w.id
    and (c.affiliate_id = w.affiliate_id or c.affiliate_id is null)
) f
where w.fulfillment = 'shipping'
  and not a.is_in_house
  and f.filters > 0;

comment on view public.work_order_shop_deductions is
  'Automatic deductions on the shop''s bill: $15 (private.shop_shipping_deduction_per_filter) per part shipped (DPF, DOC, SCR or EGR cooler component) on shipped orders, not for the in-house shop. Computed, never stored.';

-- Grants (20261020000000_explicit_api_grants.sql): read only, like work_order_financials.
revoke all on table public.work_order_shop_deductions from public, anon, authenticated, service_role;
grant maintain, select on table public.work_order_shop_deductions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_shop_deductions to service_role;
