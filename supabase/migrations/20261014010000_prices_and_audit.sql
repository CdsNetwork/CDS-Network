-- Price changes in one transaction, and an audit trail for admin edits.

-- Sets the price in effect from today. Never edits history: the current row is closed
-- and a new one starts today (or the current row is updated if it started today).
-- p_amount null ends the price from today.
--   p_kind 'shop_rate': default shop rate (shop_rates, affiliate_id null)
--   p_kind 'fleet':     fleet price (sell_prices)
--   p_kind 'override':  customer price (customer_price_overrides, needs p_customer)
create function public.cds_set_price(p_kind text, p_catalog_item uuid, p_customer uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  today date := current_date;
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

-- Audit trail: who changed prices, catalog, shops, logins, locations and settings.
create function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_log (actor_id, table_name, row_id, action, old_data, new_data)
  values (
    auth.uid(),
    tg_table_name,
    coalesce(rec ->> 'id', rec ->> 'affiliate_id', rec ->> 'customer_id', rec ->> 'key', ''),
    lower(tg_op),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;
revoke all on function private.audit() from public;

do $$
declare t text;
begin
  foreach t in array array[
    'shop_rates', 'sell_prices', 'customer_price_overrides', 'catalog_items', 'affiliates',
    'affiliate_contacts', 'profiles', 'customers', 'customer_billing', 'customer_locations', 'app_settings'
  ] loop
    execute format(
      'create trigger audit after insert or update or delete on public.%I for each row execute function private.audit()', t);
  end loop;
end $$;
