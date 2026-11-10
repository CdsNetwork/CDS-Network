-- Shop rates for one customer (2026-11-10).
--
-- Why: for GESi replacement filters (catalog items CDS-DPF-GESI...) what CDS pays the shop
-- depends on the customer of the work order: one amount on First Student orders, another on
-- every other order (Ryder and the rest). Until now a shop rate varied only by item, market
-- and optionally shop (affiliate).
--
-- 1. public.shop_rates.customer_id (nullable): a rate row that applies to that customer's
--    work orders only. Null = every customer, as before.
-- 2. The unique index includes the customer.
-- 3. One resolver, private.shop_rate_pick, picks the rate for a work order line. The most
--    specific row in effect on the date wins:
--      1. this shop and this customer
--      2. this customer, any shop
--      3. this shop, any customer
--      4. the default (any shop, any customer)
--    Within a level the row with the latest start date wins. Start and end dates work as
--    before (in effect when effective_from <= date < effective_to). As before, a shop or
--    customer row without an amount is skipped; a default row without one still applies.
--    It also says where the rate came from: 'shop' (levels 1 and 3), 'customer' (2) or
--    'default' (4), stored in work_order_lines.shop_rate_source, which gains 'customer'.
-- 4. private.snapshot_shop_rate (new lines) and private.resnapshot_on_reassign (order moved
--    to another shop) use it. private.shop_rate_for and private.shop_own_rate_for keep
--    their meaning (no customer rows) for anything else that calls them.
-- 5. public.cds_set_price('shop_rate', item, customer, amount): with a customer it sets that
--    customer's rate (any shop); without one, the default rate as before.
--
-- RLS is unchanged: a shop reads the rows with no shop or with its own shop, with or
-- without a customer. Shops still never read customer prices (sell_prices,
-- customer_price_overrides, work_order_line_pricing). Table grants are unchanged.
--
-- Existing lines keep their snapshotted rate. No rate rows are added here.

-- ---------------------------------------------------------------- table

alter table public.shop_rates
  add column customer_id uuid references public.customers on delete cascade;

comment on column public.shop_rates.customer_id is
  'Rate for this customer''s work orders only. Null = every customer.';

drop index public.shop_rates_uq;
create unique index shop_rates_uq on public.shop_rates (
  catalog_item_id,
  market,
  coalesce(affiliate_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
  effective_from
);
create index shop_rates_customer_idx on public.shop_rates (customer_id) where customer_id is not null;

alter table public.work_order_lines drop constraint work_order_lines_shop_rate_source_check;
alter table public.work_order_lines add constraint work_order_lines_shop_rate_source_check
  check (shop_rate_source in ('default', 'customer', 'shop', 'manual'));

-- ---------------------------------------------------------------- resolver

-- The rate CDS pays shop `shop` for `item` on an order of customer `cust` on `on_date`,
-- and its source. No row when no rate is in effect.
create function private.shop_rate_pick(item uuid, shop uuid, cust uuid, mkt public.market_code, on_date date)
returns table (amount numeric, source text)
language sql stable security definer set search_path = '' as $$
  select r.amount,
         case when r.affiliate_id is not null then 'shop'
              when r.customer_id is not null then 'customer'
              else 'default' end
  from public.shop_rates r
  where r.catalog_item_id = item and r.market = mkt
    and (r.affiliate_id is null or r.affiliate_id = shop)
    and (r.customer_id is null or r.customer_id = cust)
    and (r.amount is not null or (r.affiliate_id is null and r.customer_id is null))
    and r.effective_from <= on_date and (r.effective_to is null or r.effective_to > on_date)
  order by case
             when r.affiliate_id is not null and r.customer_id is not null then 1
             when r.customer_id is not null then 2
             when r.affiliate_id is not null then 3
             else 4
           end,
           r.effective_from desc
  limit 1
$$;
revoke all on function private.shop_rate_pick(uuid, uuid, uuid, public.market_code, date) from public;

-- Same as 20261012000000, but never a customer's rate.
create or replace function private.shop_rate_for(item uuid, shop uuid, mkt public.market_code, on_date date)
returns numeric language sql stable security definer set search_path = '' as $$
  select r.amount from public.shop_rates r
  where r.catalog_item_id = item and r.market = mkt and r.customer_id is null
    and (r.affiliate_id = shop or r.affiliate_id is null)
    and r.effective_from <= on_date and (r.effective_to is null or r.effective_to > on_date)
  order by (r.affiliate_id is null), r.effective_from desc
  limit 1
$$;

-- Same as 20261015000000, but never a customer's rate.
create or replace function private.shop_own_rate_for(item uuid, shop uuid, mkt public.market_code, on_date date)
returns numeric language sql stable security definer set search_path = '' as $$
  select r.amount from public.shop_rates r
  where shop is not null and r.catalog_item_id = item and r.market = mkt and r.affiliate_id = shop
    and r.customer_id is null
    and r.effective_from <= on_date and (r.effective_to is null or r.effective_to > on_date)
  order by r.effective_from desc
  limit 1
$$;

-- ---------------------------------------------------------------- line snapshots

-- Same as 20261019000000, with the rate from private.shop_rate_pick (the order's customer
-- counts).
create or replace function private.snapshot_shop_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  per_line boolean;
  picked_amount numeric;
  picked_source text;
begin
  select w.affiliate_id, w.customer_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  select c.price_per_line into per_line from public.catalog_items c where c.id = new.catalog_item_id;
  if coalesce(per_line, false) then
    if new.shop_unit_rate is null or new.shop_unit_rate <= 0 or not private.is_cds() then
      raise exception 'Misc. hardware is added by CDS with the amount from the shop''s invoice'
        using errcode = 'P0001';
    end if;
    new.shop_rate_source := 'manual';
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

-- Same as 20261015030000, with the rate from private.shop_rate_pick. A work order moved to
-- another shop: each line is re-snapshotted with rates in effect on the day the line was
-- created. A rate of the new shop (with or without this customer) that wins over the
-- customer's and the default rate replaces the line's rate. Else, a line that carried the
-- previous shop's own rate gets the customer's rate or the default rate. Else (default,
-- customer or CDS-typed) the rate stays as it is.
create or replace function private.resnapshot_on_reassign() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  l record;
  created_on date;
  picked_amount numeric;
  picked_source text;
  fallback_amount numeric;
  fallback_source text;
begin
  if old.affiliate_id is not null then
    delete from public.work_order_lines where work_order_id = new.id and origin = 'shop_added';
    update public.authorization_requests set status = 'withdrawn'
     where work_order_id = new.id and status = 'pending';
  end if;

  perform set_config('cds.resnapshot', 'on', true);
  for l in select ln.id, ln.catalog_item_id, ln.created_at, ln.shop_rate_source
             from public.work_order_lines ln where ln.work_order_id = new.id loop
    created_on := (l.created_at at time zone 'America/Los_Angeles')::date;
    picked_amount := null;
    picked_source := null;
    select p.amount, p.source into picked_amount, picked_source
      from private.shop_rate_pick(l.catalog_item_id, new.affiliate_id, new.customer_id, new.market, created_on) p;
    if picked_source = 'shop' then
      update public.work_order_lines set shop_unit_rate = picked_amount, shop_rate_source = 'shop' where id = l.id;
    elsif l.shop_rate_source = 'shop' then
      fallback_amount := null;
      fallback_source := null;
      select p.amount, p.source into fallback_amount, fallback_source
        from private.shop_rate_pick(l.catalog_item_id, null, new.customer_id, new.market, created_on) p;
      if fallback_amount is null then
        select p.amount, p.source into fallback_amount, fallback_source
          from private.shop_rate_pick(l.catalog_item_id, null, new.customer_id, new.market, private.today()) p;
      end if;
      update public.work_order_lines
         set shop_unit_rate = fallback_amount,
             shop_rate_source = coalesce(fallback_source, 'default')
       where id = l.id;
    end if;
  end loop;
  perform set_config('cds.resnapshot', '', true);
  return null;
end $$;

-- ---------------------------------------------------------------- CDS price editing

-- Same as 20261015030000, plus: for 'shop_rate', p_customer (optional) sets that
-- customer's rate for any shop; without it, the default rate (no shop, no customer).
create or replace function public.cds_set_price(p_kind text, p_catalog_item uuid, p_customer uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  today date := private.today();
  cur_id uuid;
  cur_from date;
  cur_amount numeric;
begin
  perform private.require_cds();
  if p_amount is not null and p_amount < 0 then
    raise exception 'A price cannot be negative' using errcode = 'P0001';
  end if;

  if p_kind = 'shop_rate' then
    select id, effective_from, amount into cur_id, cur_from, cur_amount from public.shop_rates
    where catalog_item_id = p_catalog_item and market = 'US' and affiliate_id is null
      and customer_id is not distinct from p_customer
      and effective_from <= today and (effective_to is null or effective_to > today)
    order by effective_from desc limit 1 for update;
  elsif p_kind = 'fleet' then
    select id, effective_from, amount into cur_id, cur_from, cur_amount from public.sell_prices
    where catalog_item_id = p_catalog_item and market = 'US'
      and effective_from <= today and (effective_to is null or effective_to > today)
    order by effective_from desc limit 1 for update;
  elsif p_kind = 'override' then
    if p_customer is null then
      raise exception 'Choose a customer' using errcode = 'P0001';
    end if;
    select id, effective_from, amount into cur_id, cur_from, cur_amount from public.customer_price_overrides
    where catalog_item_id = p_catalog_item and customer_id = p_customer and market = 'US'
      and effective_from <= today and (effective_to is null or effective_to > today)
    order by effective_from desc limit 1 for update;
  else
    raise exception 'Unknown price kind %', p_kind using errcode = 'P0001';
  end if;

  if cur_id is not null and cur_amount is not distinct from p_amount then
    return;
  end if;

  -- End or replace the current row.
  if cur_id is not null then
    if cur_from = today then
      if p_amount is null then
        execute format('delete from public.%I where id = $1',
          case p_kind when 'shop_rate' then 'shop_rates' when 'fleet' then 'sell_prices' else 'customer_price_overrides' end)
          using cur_id;
      else
        execute format('update public.%I set amount = $1 where id = $2',
          case p_kind when 'shop_rate' then 'shop_rates' when 'fleet' then 'sell_prices' else 'customer_price_overrides' end)
          using p_amount, cur_id;
      end if;
      return;
    end if;
    execute format('update public.%I set effective_to = $1 where id = $2',
      case p_kind when 'shop_rate' then 'shop_rates' when 'fleet' then 'sell_prices' else 'customer_price_overrides' end)
      using today, cur_id;
  end if;

  if p_amount is null then
    return;
  end if;
  if p_kind = 'shop_rate' then
    insert into public.shop_rates (catalog_item_id, market, customer_id, amount, effective_from)
    values (p_catalog_item, 'US', p_customer, p_amount, today);
  elsif p_kind = 'fleet' then
    insert into public.sell_prices (catalog_item_id, market, amount, effective_from) values (p_catalog_item, 'US', p_amount, today);
  else
    insert into public.customer_price_overrides (customer_id, catalog_item_id, market, amount, effective_from)
    values (p_customer, p_catalog_item, 'US', p_amount, today);
  end if;
end $$;
