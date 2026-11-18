-- Shop shipping credit for filters sold on orders without components (Sarah, CDS,
-- 2026-11-18: "the shipping credit is not showing up on affiliate bills where there are no
-- components added (like where a filter is sold)").
--
-- Same view as 20261119050000_shipping_deduction_egr.sql ($15 per part,
-- private.shop_shipping_deduction_per_filter(), never for the in-house shop) with one rule
-- added:
--   * the order has components recorded by its current shop (or by no shop): unchanged, it
--     counts them on 'shipping' orders only;
--   * the order has none: it counts the filters sold on it (private.wo_sold_filters,
--     20261119120000_customer_shipping_charge.sql: CDS-RECON-DPF/DOC/SCR, CDS-NEW-FILTER and
--     GESi filters CDS-DPF/DOC/SCR-GESI..., by line quantity) when the order is shipped
--     ('shipping', or 'supplier_direct': the supplier ships the part to the customer) and
--     its shop bill is not yet in QuickBooks (private.wo_has_shop_bill): bills already
--     created are not changed.
-- The column names stay (kind 'filter_shipping', 'filters' = parts shipped), so
-- work_order_financials, the shop bill and the pages read it unchanged.

create or replace function private.wo_has_shop_bill(p_work_order uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.qbo_shop_bills b where b.work_order_id = p_work_order and b.qb_bill_id is not null)
      or exists (select 1 from public.work_order_internal i where i.work_order_id = p_work_order and i.qb_bill_id is not null)
$$;
revoke all on function private.wo_has_shop_bill(uuid) from public;
grant execute on function private.wo_has_shop_bill(uuid) to authenticated, service_role;

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
  select count(*) as parts
  from public.work_order_components c
  where c.work_order_id = w.id
    and (c.affiliate_id = w.affiliate_id or c.affiliate_id is null)
) p
cross join lateral (
  select case
    when p.parts > 0 then case when w.fulfillment = 'shipping' then p.parts else 0 end
    when w.fulfillment in ('shipping', 'supplier_direct') and not private.wo_has_shop_bill(w.id)
      then (select s.filters + s.gesi_filters from private.wo_sold_filters(w.id) s)
    else 0
  end as filters
) f
where not a.is_in_house
  and f.filters > 0;

comment on view public.work_order_shop_deductions is
  'Automatic deductions on the shop''s bill: $15 (private.shop_shipping_deduction_per_filter) per part shipped on shipped orders, not for the in-house shop. Parts = the DPF, DOC, SCR and EGR cooler components of the order''s shop on shipping orders; when there are none, the filters sold (private.wo_sold_filters, GESi included) on shipping or supplier direct orders whose shop bill is not yet in QuickBooks. Computed, never stored.';

-- Grants unchanged (create or replace keeps them): read only, like work_order_financials.
