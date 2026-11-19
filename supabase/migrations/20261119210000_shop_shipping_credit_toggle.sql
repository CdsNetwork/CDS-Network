-- "Shipping credit from shop" per order (Sarah, CDS, 2026-11-19).
--
-- NOx sensor orders were entered as Service and the shop recorded a DPF to get past the
-- measurements, so the shop's bill got the $15 shipping credit although the shop gives none on
-- that order. CDS can now turn the credit off (or back on) on any order.
--
--   1. work_order_internal.shop_shipping_credit (not null, default true): CDS only, like every
--      work_order_internal column (only the cds_all policy, so a shop can neither read nor
--      change it). Existing orders get true: nothing changes until CDS turns it off.
--   2. private.wo_shop_shipping_credit(order): the flag, true when the order has no
--      work_order_internal row. Security definer so the view below (security invoker) gives a
--      shop the same answer as CDS without letting it read work_order_internal.
--   3. public.work_order_shop_deductions: the view of 20261119140000 with one rule added, the
--      order has no row when the flag is false. No row rather than an amount of 0: every
--      reader (work_order_financials, the shop bill builder, the CDS work order page, the
--      shop's job page and settlement preview, the sheets export) already handles an order
--      with no deduction, and a $0 row would print a "Shipping deduction ... $0.00" line on
--      the bill and the pages.
--   4. The flag is locked once the shop's bill is in QuickBooks (private.wo_has_shop_bill) and
--      while it is being created (a 'creating' claim younger than 5 minutes, as
--      public.qbo_claim_shop_bill counts it): bills already created never change. The change
--      takes a key share lock on the order, so it waits for a claim being taken on it, and a
--      claim waits until the change is committed.
-- The customer shipping charge (public.work_order_customer_shipping) does not read the flag.
-- Grants: no new public object (the column follows the table's grants), snapshot unchanged.

-- ---------------------------------------------------------------- 1. column

alter table public.work_order_internal add column shop_shipping_credit boolean not null default true;
comment on column public.work_order_internal.shop_shipping_credit is
  'CDS only: the shop gives the $15 per part shipping credit on this order (public.work_order_shop_deductions). False for orders where the shop gives none, for example NOx sensors entered as Service. Locked once the shop''s bill is in QuickBooks.';

-- ---------------------------------------------------------------- 2. reader

create function private.wo_shop_shipping_credit(p_work_order uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select i.shop_shipping_credit from public.work_order_internal i where i.work_order_id = p_work_order), true)
$$;
revoke all on function private.wo_shop_shipping_credit(uuid) from public;
grant execute on function private.wo_shop_shipping_credit(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- 3. view

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
  and f.filters > 0
  and private.wo_shop_shipping_credit(w.id);

comment on view public.work_order_shop_deductions is
  'Automatic deductions on the shop''s bill: $15 (private.shop_shipping_deduction_per_filter) per part shipped on shipped orders, not for the in-house shop, and not when CDS turned the credit off on the order (work_order_internal.shop_shipping_credit false). Parts = the DPF, DOC, SCR and EGR cooler components of the order''s shop on shipping orders; when there are none, the filters sold (private.wo_sold_filters, GESi included) on shipping or supplier direct orders whose shop bill is not yet in QuickBooks. Computed, never stored.';

-- Grants unchanged (create or replace keeps them): read only, like work_order_financials.

-- ---------------------------------------------------------------- 4. lock

create function private.shop_shipping_credit_locked() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.shop_shipping_credit is not distinct from old.shop_shipping_credit then
    return new;
  end if;
  perform 1 from public.work_orders w where w.id = new.work_order_id for key share;
  if old.qb_bill_id is not null or private.wo_has_shop_bill(new.work_order_id) then
    raise exception 'The shipping credit cannot change: the shop''s bill is in QuickBooks.' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.qbo_shop_bills b
     where b.work_order_id = new.work_order_id
       and b.status = 'creating'
       and b.claimed_at > now() - interval '5 minutes'
  ) then
    raise exception 'The shipping credit cannot change while the shop''s bill is being created. Refresh in a moment.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function private.shop_shipping_credit_locked() from public;

create trigger work_order_internal_shop_shipping_credit_locked
  before update on public.work_order_internal
  for each row execute function private.shop_shipping_credit_locked();
