-- Shared shipping deduction on the shop's bill (2026-11-11).
--
-- CDS's affiliate price sheet (SOP tab): "$15.00 per filter round trip, shared shipping cost,
-- to be deducted from bill". CDS confirmed (2026-11-10) it applies to every customer's
-- shipped orders. So on a shipped order the shop's bill gets one deduction line:
-- minus $15.00 times the number of filters on the order.
--
-- Rule, computed here and nowhere else (never stored, so it follows every change):
--   * the order's fulfillment is 'shipping' (pickup / local delivery, supplier direct and
--     unspecified orders get nothing);
--   * the order's shop is not CDS's in-house shop (CDS does not bill itself);
--   * filters = the order's components recorded by its current shop that are not EGR
--     coolers (DPF, DOC and SCR), the same count as FILTER QTY in the Sheets backup;
--   * no row when there are no filters.
-- The amount per filter is the single setting private.shop_shipping_deduction_per_filter().
--
-- The customer invoice is untouched: the deduction is not a work order line and has no
-- customer price. work_order_financials includes it in shop_subtotal and the margins.

create function private.shop_shipping_deduction_per_filter() returns numeric
language sql immutable set search_path = '' as $$
  -- Dollars deducted from the shop's bill per filter round trip on a shipped order.
  select 15.00::numeric(12,2)
$$;
revoke all on function private.shop_shipping_deduction_per_filter() from public;
grant execute on function private.shop_shipping_deduction_per_filter() to authenticated, service_role;

-- security_invoker: the caller's RLS applies to every table read here, so a shop sees the
-- deduction of its own orders only (the ones it can see), and CDS sees every order's.
create view public.work_order_shop_deductions with (security_invoker = true) as
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
    and c.component_type <> 'EGR'
    and (c.affiliate_id = w.affiliate_id or c.affiliate_id is null)
) f
where w.fulfillment = 'shipping'
  and not a.is_in_house
  and f.filters > 0;

comment on view public.work_order_shop_deductions is
  'Automatic deductions on the shop''s bill: $15 (private.shop_shipping_deduction_per_filter) per filter (DPF, DOC, SCR component) on shipped orders, not for the in-house shop. Computed, never stored.';

-- Same view as 20261012000000_core_schema.sql, with the deductions in the shop subtotal and
-- the margins, and the deduction total as a new last column.
create or replace view public.work_order_financials with (security_invoker = true) as
select
  w.id as work_order_id,
  w.wo_number,
  coalesce(l.customer_subtotal, 0)::numeric(12,2) as customer_subtotal,
  (coalesce(l.shop_subtotal, 0) + coalesce(d.deductions, 0))::numeric(12,2) as shop_subtotal,
  coalesce(s.shipping_cost, 0)::numeric(12,2) as shipping_cost,
  (coalesce(l.customer_subtotal, 0) - coalesce(l.shop_subtotal, 0) - coalesce(d.deductions, 0))::numeric(12,2)
    as margin_before_shipping,
  (coalesce(l.customer_subtotal, 0) - coalesce(l.shop_subtotal, 0) - coalesce(d.deductions, 0)
    - coalesce(s.shipping_cost, 0))::numeric(12,2) as margin,
  i.supplier_cost_tbd,
  coalesce(d.deductions, 0)::numeric(12,2) as shop_deductions
from public.work_order_internal i
join public.work_orders w on w.id = i.work_order_id
left join lateral (
  select sum(p.customer_unit_price * ln.qty) as customer_subtotal,
         sum(coalesce(ln.shop_unit_rate, 0) * ln.qty) as shop_subtotal
  from public.work_order_lines ln
  join public.work_order_line_pricing p on p.line_id = ln.id
  where ln.work_order_id = w.id
) l on true
left join lateral (
  select sum(sd.amount) as deductions
  from public.work_order_shop_deductions sd
  where sd.work_order_id = w.id
) d on true
left join lateral (
  select sum(coalesce(c.actual_cost, c.quoted_cost, 0)) as shipping_cost
  from public.shipments sh
  join public.shipment_internal c on c.shipment_id = sh.id
  where sh.work_order_id = w.id
) s on true
where (select private.is_cds());

-- Grants (20261020000000_explicit_api_grants.sql): read only, like work_order_financials.
revoke all on table public.work_order_shop_deductions from public, anon, authenticated, service_role;
grant maintain, select on table public.work_order_shop_deductions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_shop_deductions to service_role;
