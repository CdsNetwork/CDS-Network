-- Automatic shipping charge on the customer's QuickBooks invoice (CDS, 2026-11-18).
--
-- A shipped order is charged a flat round trip (to the shop and back) shipping amount in the
-- invoice's own Shipping box: $28 per filter (DPF, DOC, SCR) and $34 per EGR cooler. Example:
-- a DPF and a DOC on one shipped order = $56. A GESi filter sold is charged on the QuickBooks
-- item "Shipping and Handling (G)" instead: $28 per GESi filter, $150 per GESi filter when
-- it was overnighted (Sarah, CDS, 2026-11-18).
--
--   1. customer_billing.charge_shipping (default true): whether the customer is charged. The
--      customers named like 'First Student%' are set to false (no shipping charge for them).
--   2. app_settings 'customer_shipping_rates' =
--      {"filter": 28, "egr_cooler": 34, "gesi_filter": 28, "gesi_overnight": 150}: the rates,
--      read through private.customer_shipping_rates() (the defaults when the row or a key is
--      missing or not a valid amount).
--      private.shipping_filter_kind(sku): which catalog items are filters sold. By SKU, as the
--      catalog has no filter category (categories: service, gasket, bung, clamp, part):
--        'gesi'   CDS-DPF-GESI..., CDS-DOC-GESI..., CDS-SCR-GESI... (GESi replacement filters);
--        'filter' CDS-RECON-DPF/DOC/SCR..., CDS-DPF/DOC/SCR-RECON... (reconditioned) and
--                 CDS-NEW-FILTER / "CDS-NEW FILTER" (new filter priced on the order).
--      Cleaning services (SVC-DPF, CDS-DPF-CLEAN...) are not sold filters: the filter is the
--      customer's own and is counted as a component. No EGR cooler sale SKU is known, so
--      none is counted from lines.
--      private.wo_sold_filters(order): the quantity of those lines, split filter / gesi.
--      private.wo_overnight_label(order): the order has an active, non-test portal label
--      whose service is overnight or next day (fedex_standard_overnight,
--      fedex_priority_overnight, wwex_ups_next_day_*: code or name with "overnight" or
--      "next day"). Labels bought outside the portal are not seen: the GESi charge stays $28
--      and CDS sets the override.
--   3. work_order_internal.customer_shipping_override (CDS only, null = automatic): an amount
--      CDS sets for a one-off (0 = no shipping on this order). It is the order's whole
--      shipping charge: on the "Shipping and Handling (G)" line when the order sells a GESi
--      filter, else in the Shipping box.
--   4. view public.work_order_customer_shipping (CDS only: it reads work_order_internal and
--      customer_billing, which shops cannot read, so a shop gets no rows). The order needs a
--      shop (any shop, CDS's in-house shop included: the shop deduction leaves the in-house
--      shop out because CDS does not credit itself, but the customer still pays shipping).
--        * Box, from components: on a 'shipping' order, every component recorded by the
--          order's current shop (or by no shop), as the shop's shipping deduction counts them
--          (public.work_order_shop_deductions): EGR coolers at the EGR rate, DPF, DOC and SCR
--          at the filter rate.
--        * Box, from filters sold (Sarah, 2026-11-18: no credit "where there are no
--          components added (like where a filter is sold)"): when the order has no such
--          component, the non-GESi filters sold on it, at the filter rate. Shipped here means
--          'shipping' or 'supplier_direct' (the supplier ships the part to the customer).
--        * GESi line: the GESi filters sold on a 'shipping' or 'supplier_direct' order (with
--          or without components) x $28, or x $150 when the order has an overnight label.
--        * Filters sold are counted only while the order has no QuickBooks invoice (and is
--          not invoiced): invoices already in QuickBooks are not changed.
--      0 when the customer is not charged. amount = the override when set, else the
--      automatic amount; box_amount and gesi_amount split it. Computed, never stored: an
--      invoiced order is never rebuilt, so nothing changes on invoices already in QuickBooks.
--   5. The override follows the invoice locks: it cannot change once the order has a
--      QuickBooks invoice or is invoiced, nor while its invoice is being created; the
--      fulfillment method is locked while the invoice is being created, like the other
--      invoice inputs (private.invoice_inputs_locked).
-- The shop's $15 credit for filters sold: 20261119140000_shipping_deduction_sold_filters.sql.
-- Grants: tests/rls/grants.snapshot.json (new view).

-- ---------------------------------------------------------------- 1. per customer

alter table public.customer_billing add column charge_shipping boolean not null default true;
comment on column public.customer_billing.charge_shipping is
  'Shipped orders of this customer get the automatic shipping charge in the QuickBooks invoice Shipping box (public.work_order_customer_shipping). False for First Student.';

insert into public.customer_billing (customer_id, charge_shipping)
select c.id, false from public.customers c where c.name ilike 'First Student%'
on conflict (customer_id) do update set charge_shipping = false;

-- ---------------------------------------------------------------- 2. rates and counts

-- Adds the keys that are missing; rates CDS already changed are kept.
insert into public.app_settings (key, value)
values ('customer_shipping_rates', '{"filter": 28, "egr_cooler": 34, "gesi_filter": 28, "gesi_overnight": 150}'::jsonb)
on conflict (key) do update set value = excluded.value || public.app_settings.value;

create function private.customer_shipping_rates()
returns table (filter_rate numeric, egr_rate numeric, gesi_rate numeric, gesi_overnight_rate numeric)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(case when jsonb_typeof(s.value -> 'filter') = 'number' and (s.value ->> 'filter')::numeric >= 0
                  then (s.value ->> 'filter')::numeric end, 28)::numeric(12,2),
    coalesce(case when jsonb_typeof(s.value -> 'egr_cooler') = 'number' and (s.value ->> 'egr_cooler')::numeric >= 0
                  then (s.value ->> 'egr_cooler')::numeric end, 34)::numeric(12,2),
    coalesce(case when jsonb_typeof(s.value -> 'gesi_filter') = 'number' and (s.value ->> 'gesi_filter')::numeric >= 0
                  then (s.value ->> 'gesi_filter')::numeric end, 28)::numeric(12,2),
    coalesce(case when jsonb_typeof(s.value -> 'gesi_overnight') = 'number' and (s.value ->> 'gesi_overnight')::numeric >= 0
                  then (s.value ->> 'gesi_overnight')::numeric end, 150)::numeric(12,2)
    from (select 1) one
    left join public.app_settings s on s.key = 'customer_shipping_rates'
$$;
revoke all on function private.customer_shipping_rates() from public;
grant execute on function private.customer_shipping_rates() to authenticated, service_role;

create or replace function private.shipping_filter_kind(p_sku text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_sku ~* '^CDS-(DPF|DOC|SCR)-GESI' then 'gesi'
    when p_sku ~* '^CDS-RECON-(DPF|DOC|SCR)' or p_sku ~* '^CDS-(DPF|DOC|SCR)-RECON' or p_sku ~* '^CDS-NEW[- ]?FILTER' then 'filter'
  end
$$;
revoke all on function private.shipping_filter_kind(text) from public;
grant execute on function private.shipping_filter_kind(text) to authenticated, service_role;

-- Security definer: the shop deduction view (read by shops) uses it too.
create or replace function private.wo_sold_filters(p_work_order uuid)
returns table (filters integer, gesi_filters integer)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.qty) filter (where private.shipping_filter_kind(c.sku) = 'filter'), 0)::integer,
         coalesce(sum(l.qty) filter (where private.shipping_filter_kind(c.sku) = 'gesi'), 0)::integer
    from public.work_order_lines l
    join public.catalog_items c on c.id = l.catalog_item_id
   where l.work_order_id = p_work_order
$$;
revoke all on function private.wo_sold_filters(uuid) from public;
grant execute on function private.wo_sold_filters(uuid) to authenticated, service_role;

create or replace function private.wo_overnight_label(p_work_order uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shipment_labels l
     where l.work_order_id = p_work_order
       and l.status = 'active'
       and not l.is_test
       and (l.service_code ~* '(overnight|next_day)' or coalesce(l.service_name, '') ~* '(overnight|next day)')
  )
$$;
revoke all on function private.wo_overnight_label(uuid) from public;
grant execute on function private.wo_overnight_label(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- 3. override

alter table public.work_order_internal
  add column customer_shipping_override numeric(12,2)
  constraint customer_shipping_override_range check (customer_shipping_override >= 0 and customer_shipping_override <= 100000);
comment on column public.work_order_internal.customer_shipping_override is
  'CDS only: the whole shipping charge for the customer invoice set by hand for this order (0 = none): on the Shipping and Handling (G) line when the order sells a GESi filter, else in the Shipping box. Null = automatic (public.work_order_customer_shipping).';

-- ---------------------------------------------------------------- 4. view

create view public.work_order_customer_shipping with (security_invoker = true) as
with base as (
  select
    w.id as work_order_id,
    w.fulfillment,
    coalesce(b.charge_shipping, true) as charge_shipping,
    i.customer_shipping_override as override_amount,
    r.filter_rate, r.egr_rate, r.gesi_rate, r.gesi_overnight_rate,
    -- Components of the order's current shop (or of no shop), as the shop deduction counts them.
    (w.fulfillment = 'shipping' and w.affiliate_id is not null and p.parts > 0) as from_components,
    p.parts, p.filters as component_filters, p.egr_coolers as component_egr,
    -- Filters sold count while the order is shipped and not yet invoiced in QuickBooks.
    (w.fulfillment in ('shipping', 'supplier_direct') and w.affiliate_id is not null
      and i.qb_invoice_id is null and w.status <> 'invoiced') as sold_counts,
    s.filters as sold_filters, s.gesi_filters as sold_gesi,
    private.wo_overnight_label(w.id) as overnight
  from public.work_orders w
  join public.work_order_internal i on i.work_order_id = w.id
  left join public.customer_billing b on b.customer_id = w.customer_id
  cross join private.customer_shipping_rates() r
  cross join lateral (
    select count(*) as parts,
           count(*) filter (where c.component_type <> 'EGR') as filters,
           count(*) filter (where c.component_type = 'EGR') as egr_coolers
      from public.work_order_components c
     where c.work_order_id = w.id
       and w.affiliate_id is not null
       and (c.affiliate_id = w.affiliate_id or c.affiliate_id is null)
  ) p
  cross join lateral private.wo_sold_filters(w.id) s
), counted as (
  select base.*,
    case when from_components then 'components'
         when parts = 0 and sold_counts and sold_filters > 0 then 'sold' end as counted_from,
    case when from_components then component_filters
         when parts = 0 and sold_counts then sold_filters else 0 end as filters,
    case when from_components then component_egr else 0 end as egr_coolers,
    case when sold_counts then sold_gesi else 0 end as gesi_filters,
    (case when overnight then gesi_overnight_rate else gesi_rate end)::numeric(12,2) as gesi_unit_amount
  from base
), priced as (
  select counted.*,
    (case when charge_shipping then filters * filter_rate + egr_coolers * egr_rate else 0 end)::numeric(12,2) as box_automatic,
    (case when charge_shipping then gesi_filters * gesi_unit_amount else 0 end)::numeric(12,2) as gesi_automatic
  from counted
)
select
  work_order_id,
  fulfillment,
  charge_shipping,
  counted_from,
  filters::integer as filters,
  egr_coolers::integer as egr_coolers,
  gesi_filters::integer as gesi_filters,
  overnight,
  filter_rate,
  egr_rate,
  gesi_rate,
  gesi_overnight_rate,
  gesi_unit_amount,
  (box_automatic + gesi_automatic)::numeric(12,2) as automatic_amount,
  override_amount,
  (case when override_amount is null then box_automatic
        when gesi_filters > 0 then 0
        else override_amount end)::numeric(12,2) as box_amount,
  (case when override_amount is null then gesi_automatic
        when gesi_filters > 0 then override_amount
        else 0 end)::numeric(12,2) as gesi_amount,
  coalesce(override_amount, box_automatic + gesi_automatic)::numeric(12,2) as amount
from priced;

comment on view public.work_order_customer_shipping is
  'CDS only: the customer shipping charge on the QuickBooks invoice (20261119120000_customer_shipping_charge.sql). box_amount goes in the Shipping box: $28 per filter (DPF, DOC, SCR) and $34 per EGR cooler on shipped orders (the in-house shop included), counted from components as the shop''s shipping deduction counts them, or from the filters sold when the order has none. gesi_amount goes on the item "Shipping and Handling (G)": $28 per GESi filter sold, $150 when the order has an overnight label. 0 for customers with charge_shipping false; work_order_internal.customer_shipping_override wins (on the GESi line when the order sells a GESi filter). Computed, never stored.';

revoke all on table public.work_order_customer_shipping from public, anon, authenticated, service_role;
grant maintain, select on table public.work_order_customer_shipping to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_customer_shipping to service_role;

-- ---------------------------------------------------------------- 5. locks

create function private.shipping_override_locked_when_invoiced() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_shipping_override is distinct from old.customer_shipping_override
     and auth.uid() is not null
     and (old.qb_invoice_id is not null or private.wo_invoiced(new.work_order_id)) then
    raise exception 'The shipping charge cannot change after the order is invoiced.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function private.shipping_override_locked_when_invoiced() from public;

create trigger work_order_internal_shipping_override_locked_when_invoiced
  before update on public.work_order_internal
  for each row execute function private.shipping_override_locked_when_invoiced();

-- The invoice input locks (20261118030000_qbo_invoice_claims.sql) with the shipping inputs added.
drop trigger invoice_inputs_locked on public.work_orders;
create trigger invoice_inputs_locked
  before update on public.work_orders
  for each row execute function private.invoice_inputs_locked('customer_id', 'location_id', 'market', 'po_number', 'unit_number', 'fulfillment');
drop trigger invoice_inputs_locked on public.work_order_internal;
create trigger invoice_inputs_locked
  before update on public.work_order_internal
  for each row execute function private.invoice_inputs_locked('tax_rate', 'tax_parts', 'tax_labor', 'tax_shipping', 'customer_shipping_override');
