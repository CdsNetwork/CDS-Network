-- Pacific business dates and a quieter change log (2026-10-15).
--
-- BUG-17: CDS works from California, but prices started on the UTC date (current_date in
-- a UTC database). A price changed at 22:56 Pacific time started "from" the next day. Every
-- business date is now the Pacific date, from private.today().
--
-- Change log: updates that change nothing a person can see (only updated_at or updated_by
-- moved) are no longer recorded.
--
-- Every function below is re-created from its latest definition with only those changes.

-- ---------------------------------------------------------------- Pacific today

create function private.today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Los_Angeles')::date
$$;
revoke all on function private.today() from public;
-- Column defaults run as the inserting role.
grant execute on function private.today() to authenticated, service_role;

alter table public.shop_rates alter column effective_from set default private.today();
alter table public.sell_prices alter column effective_from set default private.today();
alter table public.customer_price_overrides alter column effective_from set default private.today();

-- ---------------------------------------------------------------- prices

-- Same as 20261014010000, with today the Pacific date.
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
    insert into public.shop_rates (catalog_item_id, market, amount, effective_from) values (p_catalog_item, 'US', p_amount, today);
  elsif p_kind = 'fleet' then
    insert into public.sell_prices (catalog_item_id, market, amount, effective_from) values (p_catalog_item, 'US', p_amount, today);
  else
    insert into public.customer_price_overrides (customer_id, catalog_item_id, market, amount, effective_from)
    values (p_customer, p_catalog_item, 'US', p_amount, today);
  end if;
end $$;

revoke all on function public.cds_set_price(text, uuid, uuid, numeric) from public, anon;
grant execute on function public.cds_set_price(text, uuid, uuid, numeric) to authenticated;

-- ---------------------------------------------------------------- line snapshots

-- Same as 20261015000000, with the Pacific date.
create or replace function private.snapshot_shop_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  own numeric;
begin
  select w.affiliate_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  if new.shop_unit_rate is not null and private.is_cds() then
    -- A rate CDS typed in for this line.
    new.shop_rate_source := 'manual';
  else
    own := private.shop_own_rate_for(new.catalog_item_id, wo.affiliate_id, wo.market, private.today());
    if own is not null then
      new.shop_unit_rate := own;
      new.shop_rate_source := 'shop';
    else
      new.shop_unit_rate := private.shop_rate_for(new.catalog_item_id, null, wo.market, private.today());
      new.shop_rate_source := 'default';
    end if;
  end if;
  if new.added_by is null then
    new.added_by := auth.uid();
  end if;
  return new;
end $$;

-- Same as 20261012000000, with the Pacific date.
-- Customer price: the customer's override if one is in effect, else the fleet price.
create or replace function private.write_line_pricing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  item_class public.tax_class;
  price numeric(12,2);
  src public.price_source := 'customer_override';
  today date := private.today();
begin
  select w.customer_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  select c.tax_class into item_class from public.catalog_items c where c.id = new.catalog_item_id;

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

-- Same as 20261015000000, with Pacific dates: the day a line was created is its Pacific
-- date, and the fallback is the Pacific today.
create or replace function private.resnapshot_on_reassign() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  l record;
  own numeric;
  created_on date;
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
    own := private.shop_own_rate_for(l.catalog_item_id, new.affiliate_id, new.market, created_on);
    if own is not null then
      update public.work_order_lines set shop_unit_rate = own, shop_rate_source = 'shop' where id = l.id;
    elsif l.shop_rate_source = 'shop' then
      update public.work_order_lines
         set shop_unit_rate = coalesce(
               private.shop_rate_for(l.catalog_item_id, null, new.market, created_on),
               private.shop_rate_for(l.catalog_item_id, null, new.market, private.today())),
             shop_rate_source = 'default'
       where id = l.id;
    end if;
  end loop;
  perform set_config('cds.resnapshot', '', true);
  return null;
end $$;

-- ---------------------------------------------------------------- change log

-- Same as 20261015020000 (keeps actor_name), but an UPDATE that changes nothing except
-- updated_at or updated_by is not recorded.
create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  actor uuid := auth.uid();
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(old) - 'updated_at' - 'updated_by') = (to_jsonb(new) - 'updated_at' - 'updated_by') then
    return null;
  end if;
  insert into public.audit_log (actor_id, actor_name, table_name, row_id, action, old_data, new_data)
  values (
    actor,
    (select p.full_name from public.profiles p where p.id = actor),
    tg_table_name,
    coalesce(rec ->> 'id', rec ->> 'affiliate_id', rec ->> 'customer_id', rec ->> 'key', ''),
    lower(tg_op),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;
revoke all on function private.audit() from public;
