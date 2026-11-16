-- Items priced on the order added without their amount (Sarah, CDS office, 2026-11-16: a Ryder
-- order with CDS-NEW-FILTER "New Filter", an item priced on the order with no fleet price,
-- could not be created until a price was typed).
--
-- Items priced on the order are catalog_items.price_per_line and not pass_through (new and
-- reconditioned filters): CDS types the customer price on each order. Until now the line
-- could only be added with that price (cds_add_pass_through_line), so the Create Work Order
-- form and email intake could not add one at all. Now, like any item with no price yet
-- (20261117010000_work_order_without_price.sql):
--
-- 1. private.snapshot_shop_rate: CDS (any way it adds a line: Create Work Order, the "Priced
--    on this order" box, an approved extra work request) and email intake (the service role)
--    may add the line without a customer price. Shops still cannot add these items.
-- 2. private.write_line_pricing: such a line gets no price row (shown as "No price"; the
--    order's customer totals are TBD and the QuickBooks invoice is refused until it is set).
-- 3. public.cds_add_pass_through_line: p_amount may be null for an item priced on the order.
--    Misc. hardware (pass_through) still needs the amount from the shop's invoice.
-- 4. public.cds_set_line_price(line, amount) (CDS only): enters or corrects the customer price
--    of a line priced on the order, until the order is invoiced (or has a QuickBooks invoice)
--    or cancelled, also after the shop completed the work. Logged on the order's history
--    (CDS only, like the price itself).
--
-- RLS is unchanged. The new function is granted like cds_set_line_shop_rate.

-- ---------------------------------------------------------------- 1. shop rate snapshot

-- Same as 20261111090000_customer_items_and_line_prices.sql, except that an item priced on the
-- order may be added by CDS or intake without the customer price.
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
    if not private.is_cds() and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
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

-- ---------------------------------------------------------------- 2. line price snapshot

-- Same as 20261117010000_work_order_without_price.sql, except that an item priced on the order
-- added without its price gets no price row.
create or replace function private.write_line_pricing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  item_class public.tax_class;
  per_line boolean;
  pass boolean;
  price numeric(12,2);
  src public.price_source;
begin
  select w.customer_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  select c.tax_class, c.price_per_line, c.pass_through into item_class, per_line, pass
    from public.catalog_items c where c.id = new.catalog_item_id;

  if coalesce(per_line, false) then
    if pass then
      price := new.shop_unit_rate;
      if price is null then
        raise exception 'Enter the amount from the shop''s invoice' using errcode = 'P0001';
      end if;
    else
      price := nullif(current_setting('cds.line_price', true), '')::numeric;
      -- No price yet: CDS enters it on the line (cds_set_line_price) before invoicing.
      if price is null then
        return null;
      end if;
    end if;
    insert into public.work_order_line_pricing (line_id, work_order_id, customer_unit_price, price_source, tax_class)
    values (new.id, new.work_order_id, price, 'manual', item_class);
    return null;
  end if;

  select p.amount, p.source into price, src from private.customer_price(wo.customer_id, new.catalog_item_id, wo.market) p;
  -- No price yet: the line shows "No price" and the order cannot be invoiced until it is set.
  if price is null then
    return null;
  end if;

  insert into public.work_order_line_pricing (line_id, work_order_id, customer_unit_price, price_source, tax_class)
  values (new.id, new.work_order_id, price, src, item_class);
  return null;
end $$;

-- ---------------------------------------------------------------- 3. add a line priced per line

-- Same as 20261111090000_customer_items_and_line_prices.sql, except that p_amount may be null
-- for an item priced on the order (the price is entered later on the line).
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
  if (p_amount is null and item.pass_through)
     or (p_amount is not null and (p_amount <= 0 or p_amount > 99999.99 or p_amount <> round(p_amount, 2))) then
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
    perform set_config('cds.line_price', coalesce(p_amount::text, ''), true);
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

-- ---------------------------------------------------------------- 4. price entered on the line

create function public.cds_set_line_price(p_line uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  ln record;
  current_price numeric;
begin
  perform private.require_cds();
  if p_amount is null or p_amount <= 0 or p_amount > 99999.99 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter the customer price in dollars and cents' using errcode = 'P0001';
  end if;
  select l.id, l.work_order_id, c.name, c.tax_class, c.price_per_line, c.pass_through
    into ln
    from public.work_order_lines l join public.catalog_items c on c.id = l.catalog_item_id
   where l.id = p_line;
  if not found then
    raise exception 'Line not found' using errcode = 'P0002';
  end if;
  if not ln.price_per_line or ln.pass_through then
    raise exception 'Only an item priced on the order takes a price on the line' using errcode = 'P0001';
  end if;
  select * into wo from public.work_orders w where w.id = ln.work_order_id for update;
  if wo.status in ('invoiced', 'cancelled') or private.wo_invoiced(wo.id) then
    raise exception 'Prices cannot change once the work order is invoiced or cancelled' using errcode = 'P0001';
  end if;

  select p.customer_unit_price into current_price from public.work_order_line_pricing p where p.line_id = ln.id for update;
  if current_price is not distinct from p_amount then
    return;
  end if;
  if found then
    update public.work_order_line_pricing set customer_unit_price = p_amount where line_id = ln.id;
  else
    insert into public.work_order_line_pricing (line_id, work_order_id, customer_unit_price, price_source, tax_class)
    values (ln.id, wo.id, p_amount, 'manual', ln.tax_class);
  end if;
  perform private.log_event(wo.id, 'line_price_set', null, null,
    'CDS set the price for ' || ln.name || ': $' || to_char(p_amount, 'FM999990.00'), false);
end $$;

revoke all on function public.cds_set_line_price(uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.cds_set_line_price(uuid, numeric) to authenticated;
grant execute on function public.cds_set_line_price(uuid, numeric) to service_role;
