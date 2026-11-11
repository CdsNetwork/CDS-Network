-- Customer-specific items, items priced on the order, and shop rates entered on the line
-- (2026-11-11).
--
-- Why: First Student (FS) has its own QuickBooks items for gaskets and clamps: the same part
-- with "AM" at the end (CDS-G-1051AM). CDS asked to add those items, with FS's own price and
-- the shop rate entered on the order (TBD until then), and confirmed that on an FS order any
-- gasket or clamp line becomes its AM item automatically, whoever adds it. CDS also sells
-- reconditioned filters (DPF, DOC, SCR) and new filters whose price is set on each order.
--
-- 1. Customer items (catalog_items.variant_of, catalog_items.variant_customer_id): an item
--    that replaces another item on one customer's orders (CDS-G-1051AM replaces CDS-G-1051
--    on First Student's). Both columns are set or both null. The items themselves, their
--    prices and their QuickBooks links are data (internal import script), not part of this
--    migration.
--      * private.use_customer_item, a BEFORE INSERT trigger on work_order_lines that runs
--        before the rate and price snapshots: a line for an item that has an active
--        replacement for the order's customer gets the replacement; a line for a replacement
--        on another customer's order gets the regular item. Every way a line is created goes
--        through it: CDS adding a line, the shop adding a part, an approved extra work
--        request, a new work order, and email intake.
--      * Nothing else changes: the replacement's customer price is that customer's price
--        (customer_price_overrides) and its shop rate is whatever rate rows it has; without
--        any, the line has no rate (TBD), as before.
-- 2. Items priced on the order (catalog_items.pass_through = false, with price_per_line):
--    CDS enters the customer price on each line (cds_add_pass_through_line, the same
--    function as Misc. hardware) and the shop rate is TBD until CDS enters it. Misc. hardware
--    (pass_through = true, the default) is unchanged: shop rate = customer price = the amount
--    from the shop's invoice.
-- 3. public.cds_set_line_shop_rate(line, amount) (CDS only): enters the shop rate of a line
--    whose rate is TBD (no rate), or corrects a rate CDS entered before, until the order is
--    invoiced or cancelled (the shop's invoice arrives when the work is completed). Rates from
--    the price list are not changed here, and Misc. hardware is not (remove and add it again).
-- 4. public.work_order_financials.supplier_cost_tbd is also true when any line has no shop
--    rate, so the shop subtotal and the margins show TBD instead of counting the line as 0.
--
-- RLS is unchanged. Shops read catalog items as before (the two new columns hold item and
-- customer ids only) and never read customer prices.

-- ---------------------------------------------------------------- catalog columns

alter table public.catalog_items
  add column variant_of uuid references public.catalog_items on delete cascade,
  add column variant_customer_id uuid references public.customers on delete cascade,
  add column pass_through boolean not null default true,
  add constraint catalog_items_variant_check check (
    (variant_of is null) = (variant_customer_id is null) and (variant_of is null or variant_of <> id)
  );

create unique index catalog_items_variant_uq on public.catalog_items (variant_of, variant_customer_id)
  where variant_of is not null;

comment on column public.catalog_items.variant_of is
  'This item replaces that item on the orders of variant_customer_id (First Student''s AM gaskets and clamps).';
comment on column public.catalog_items.variant_customer_id is
  'The customer whose orders use this item instead of variant_of.';
comment on column public.catalog_items.pass_through is
  'Items priced per line only. True: the shop is paid the amount entered and the customer is billed the same (Misc. hardware). False: CDS enters the customer price on the line; the shop rate is entered separately (TBD until then).';

-- ---------------------------------------------------------------- customer items

create function private.use_customer_item() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  cust uuid;
  base uuid;
  base_customer uuid;
  replacement uuid;
begin
  select w.customer_id into cust from public.work_orders w where w.id = new.work_order_id;
  select c.variant_of, c.variant_customer_id into base, base_customer
    from public.catalog_items c where c.id = new.catalog_item_id;
  -- Another customer's item: the regular item.
  if base is not null and base_customer is distinct from cust then
    new.catalog_item_id := base;
  end if;
  select v.id into replacement from public.catalog_items v
   where v.variant_of = new.catalog_item_id and v.variant_customer_id = cust and v.active;
  if replacement is not null then
    new.catalog_item_id := replacement;
  end if;
  return new;
end $$;
revoke all on function private.use_customer_item() from public;

-- BEFORE triggers run in name order: this one before snapshot_prices.
create trigger customer_item before insert on public.work_order_lines
  for each row execute function private.use_customer_item();

-- ---------------------------------------------------------------- line snapshots

-- Same as 20261110020000, plus: an item priced on the order (price_per_line, not
-- pass_through) is added by CDS with the customer price; its shop rate is the one CDS typed,
-- or none (TBD).
create or replace function private.snapshot_shop_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  item record;
  picked_amount numeric;
  picked_source text;
begin
  select w.affiliate_id, w.customer_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  select c.name, c.price_per_line, c.pass_through into item from public.catalog_items c where c.id = new.catalog_item_id;
  if coalesce(item.price_per_line, false) and item.pass_through then
    if new.shop_unit_rate is null or new.shop_unit_rate <= 0 or not private.is_cds() then
      raise exception 'Misc. hardware is added by CDS with the amount from the shop''s invoice'
        using errcode = 'P0001';
    end if;
    new.shop_rate_source := 'manual';
  elsif coalesce(item.price_per_line, false) then
    if not private.is_cds() or nullif(current_setting('cds.line_price', true), '') is null then
      raise exception '% is added by CDS with the customer price for this order', item.name
        using errcode = 'P0001';
    end if;
    new.shop_rate_source := case when new.shop_unit_rate is null then 'default' else 'manual' end;
  elsif new.shop_unit_rate is not null and private.is_cds() then
    -- A rate CDS typed in for this line.
    new.shop_rate_source := 'manual';
  else
    select p.amount, p.source into picked_amount, picked_source
      from private.shop_rate_pick(new.catalog_item_id, wo.affiliate_id, wo.customer_id, wo.market, private.today()) p;
    new.shop_unit_rate := picked_amount;
    new.shop_rate_source := coalesce(picked_source, 'default');
  end if;
  if new.added_by is null then
    new.added_by := auth.uid();
  end if;
  return new;
end $$;

-- Same as 20261019000000, plus: an item priced on the order is billed at the customer price
-- CDS entered (cds_add_pass_through_line).
create or replace function private.write_line_pricing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  item_class public.tax_class;
  per_line boolean;
  pass boolean;
  price numeric(12,2);
  src public.price_source := 'customer_override';
  today date := private.today();
begin
  select w.customer_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  select c.tax_class, c.price_per_line, c.pass_through into item_class, per_line, pass
    from public.catalog_items c where c.id = new.catalog_item_id;

  if coalesce(per_line, false) then
    if pass then
      price := new.shop_unit_rate;
    else
      price := nullif(current_setting('cds.line_price', true), '')::numeric;
    end if;
    if price is null then
      raise exception 'Enter the customer price for this order' using errcode = 'P0001';
    end if;
    insert into public.work_order_line_pricing (line_id, work_order_id, customer_unit_price, price_source, tax_class)
    values (new.id, new.work_order_id, price, 'manual', item_class);
    return null;
  end if;

  select o.amount into price from public.customer_price_overrides o
  where o.customer_id = wo.customer_id and o.catalog_item_id = new.catalog_item_id and o.market = wo.market
    and o.effective_from <= today and (o.effective_to is null or o.effective_to > today)
  order by o.effective_from desc limit 1;

  if price is null then
    src := 'fleet';
    select s.amount into price from public.sell_prices s
    where s.catalog_item_id = new.catalog_item_id and s.market = wo.market
      and s.effective_from <= today and (s.effective_to is null or s.effective_to > today)
    order by s.effective_from desc limit 1;
  end if;

  if price is null then
    raise exception 'No customer price for catalog item % in market %', new.catalog_item_id, wo.market
      using errcode = 'P0001';
  end if;

  insert into public.work_order_line_pricing (line_id, work_order_id, customer_unit_price, price_source, tax_class)
  values (new.id, new.work_order_id, price, src, item_class);
  return null;
end $$;

-- Same as 20261019000000, plus items priced on the order: p_amount is the customer price,
-- the description is optional, and the shop rate is TBD (cds_set_line_shop_rate).
create or replace function public.cds_add_pass_through_line(
  p_work_order uuid, p_catalog_item uuid, p_description text, p_amount numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  item public.catalog_items;
  text_in text := btrim(coalesce(p_description, ''));
  line uuid;
begin
  perform private.require_cds();
  select * into item from public.catalog_items c where c.id = p_catalog_item;
  if not found or not item.price_per_line or not item.active then
    raise exception 'This item is not priced per line' using errcode = 'P0001';
  end if;
  if text_in = '' and item.pass_through then
    raise exception 'Enter a description' using errcode = 'P0001';
  end if;
  perform private.check_length(text_in, 500);
  if p_amount is null or p_amount <= 0 or p_amount > 99999.99 or p_amount <> round(p_amount, 2) then
    if item.pass_through then
      raise exception 'Enter the amount from the shop''s invoice in dollars and cents' using errcode = 'P0001';
    end if;
    raise exception 'Enter the customer price in dollars and cents' using errcode = 'P0001';
  end if;

  select * into wo from public.work_orders w where w.id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status in ('invoiced', 'cancelled') then
    raise exception 'Lines cannot change once the work order is invoiced or cancelled' using errcode = 'P0001';
  end if;

  if item.pass_through then
    insert into public.work_order_lines (work_order_id, catalog_item_id, qty, shop_unit_rate, origin, description)
    values (wo.id, item.id, 1, p_amount, 'cds_order', text_in)
    returning id into line;
  else
    perform set_config('cds.line_price', p_amount::text, true);
    insert into public.work_order_lines (work_order_id, catalog_item_id, qty, origin, description)
    values (wo.id, item.id, 1, 'cds_order', nullif(text_in, ''))
    returning id into line;
    perform set_config('cds.line_price', '', true);
  end if;
  perform private.log_event(wo.id, 'line_added', null, null,
    'CDS added ' || item.name || coalesce(': ' || nullif(text_in, ''), ''),
    wo.status not in ('pending_review', 'rejected_by_affiliate'));
  return line;
end $$;

-- ---------------------------------------------------------------- shop rate on the line

create function public.cds_set_line_shop_rate(p_line uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  ln record;
begin
  perform private.require_cds();
  if p_amount is null or p_amount < 0 or p_amount > 99999.99 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter the shop rate in dollars and cents' using errcode = 'P0001';
  end if;
  select l.id, l.work_order_id, l.shop_unit_rate, l.shop_rate_source, c.name, c.price_per_line, c.pass_through
    into ln
    from public.work_order_lines l join public.catalog_items c on c.id = l.catalog_item_id
   where l.id = p_line;
  if not found then
    raise exception 'Line not found' using errcode = 'P0002';
  end if;
  if ln.price_per_line and ln.pass_through then
    raise exception 'The shop is paid the amount on its invoice for this item: remove the line and add it again'
      using errcode = 'P0001';
  end if;
  if ln.shop_unit_rate is not null and ln.shop_rate_source <> 'manual' then
    raise exception 'This line has the shop rate from the price list' using errcode = 'P0001';
  end if;
  select * into wo from public.work_orders w where w.id = ln.work_order_id for update;
  if wo.status in ('invoiced', 'cancelled') then
    raise exception 'Lines cannot change once the work order is invoiced or cancelled' using errcode = 'P0001';
  end if;

  perform set_config('cds.resnapshot', 'on', true);
  update public.work_order_lines set shop_unit_rate = p_amount, shop_rate_source = 'manual' where id = ln.id;
  perform set_config('cds.resnapshot', '', true);
  perform private.log_event(wo.id, 'line_rate_set', null, null,
    'CDS set the shop rate for ' || ln.name || ': $' || to_char(p_amount, 'FM999990.00'),
    wo.status not in ('pending_review', 'rejected_by_affiliate'));
end $$;

revoke all on function public.cds_set_line_shop_rate(uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.cds_set_line_shop_rate(uuid, numeric) to authenticated;
grant execute on function public.cds_set_line_shop_rate(uuid, numeric) to service_role;

-- ---------------------------------------------------------------- financials

-- Same as 20261111030000_shop_filter_shipping_deduction.sql, plus: supplier_cost_tbd is also
-- true when a line has no shop rate yet (TBD), so the shop subtotal and the margins are not
-- shown as if that line cost nothing.
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
  (i.supplier_cost_tbd or coalesce(l.rate_missing, false)) as supplier_cost_tbd,
  coalesce(d.deductions, 0)::numeric(12,2) as shop_deductions
from public.work_order_internal i
join public.work_orders w on w.id = i.work_order_id
left join lateral (
  select sum(p.customer_unit_price * ln.qty) as customer_subtotal,
         sum(coalesce(ln.shop_unit_rate, 0) * ln.qty) as shop_subtotal,
         bool_or(ln.shop_unit_rate is null) as rate_missing
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
