-- Work orders with an item that has no price yet (Sarah, CDS office, 2026-11-16: "Can we
-- change this to where we do not have to require a price to create a work order like this?",
-- a Ryder order with CDS-NEW FILTER, which has no Ryder price and no fleet price).
--
-- 1. private.write_line_pricing: a line whose item has no customer price and no fleet price is
--    added without a price (no work_order_line_pricing row) instead of being refused. This is
--    the one place every line gets its price, so the rule is the same for the Create Work
--    Order form, + Add Item, a part the shop adds, an approved extra work request and email
--    intake (which used to leave such lines off the draft). Items priced on the order (Misc.
--    hardware, reconditioned filters) still need their amount, as before.
-- 2. private.customer_price(customer, item, market): the price lookup itself (the customer's
--    price, else the fleet price, on today's Pacific date), shared by 1 and 3.
-- 3. Setting the price later: when a fleet price (sell_prices, Catalog) or a customer's price
--    (customer_price_overrides, Pricing) is saved and is in effect today, the lines of that
--    item that have no price get it, on orders that are not invoiced (or have a QuickBooks
--    invoice) or cancelled; a customer's price only on that customer's orders. Each line
--    filled is logged on the order's history (CDS only). Lines that have a price keep it.
-- 4. public.work_order_financials gets customer_price_missing (true while a line has no
--    price), so the customer subtotal and the margins show TBD instead of counting the line as
--    $0. Lines without a price now also count toward the shop subtotal (the join to
--    work_order_line_pricing is a left join; before, every line had a price row).
--
-- The QuickBooks invoice is refused while a line has no price (src/lib/qbo/invoice.ts:
-- "Set a price for <SKU> before creating the invoice."). RLS and grants are unchanged: the new
-- functions are private and revoked from public; the view keeps its grants.

-- ---------------------------------------------------------------- 2. price lookup

create function private.customer_price(p_customer uuid, p_catalog_item uuid, p_market public.market_code)
returns table (amount numeric, source public.price_source)
language plpgsql stable security definer set search_path = '' as $$
declare
  today date := private.today();
  price numeric(12,2);
begin
  select o.amount into price from public.customer_price_overrides o
  where o.customer_id = p_customer and o.catalog_item_id = p_catalog_item and o.market = p_market
    and o.effective_from <= today and (o.effective_to is null or o.effective_to > today)
  order by o.effective_from desc limit 1;
  if price is not null then
    return query select price::numeric, 'customer_override'::public.price_source;
    return;
  end if;

  select s.amount into price from public.sell_prices s
  where s.catalog_item_id = p_catalog_item and s.market = p_market
    and s.effective_from <= today and (s.effective_to is null or s.effective_to > today)
  order by s.effective_from desc limit 1;
  if price is not null then
    return query select price::numeric, 'fleet'::public.price_source;
  end if;
end $$;
revoke all on function private.customer_price(uuid, uuid, public.market_code) from public;

-- ---------------------------------------------------------------- 1. line snapshot

-- Same as 20261111090000_customer_items_and_line_prices.sql, except that a line with no
-- customer price and no fleet price gets no price row instead of an error.
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

  select p.amount, p.source into price, src from private.customer_price(wo.customer_id, new.catalog_item_id, wo.market) p;
  -- No price yet: the line shows "No price" and the order cannot be invoiced until it is set.
  if price is null then
    return null;
  end if;

  insert into public.work_order_line_pricing (line_id, work_order_id, customer_unit_price, price_source, tax_class)
  values (new.id, new.work_order_id, price, src, item_class);
  return null;
end $$;

-- ---------------------------------------------------------------- 3. price set later

create function private.fill_missing_line_prices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  today date := private.today();
  only_customer uuid;
  ln record;
begin
  if new.effective_from > today or (new.effective_to is not null and new.effective_to <= today) then
    return null;
  end if;
  if tg_table_name = 'customer_price_overrides' then
    only_customer := new.customer_id;
  end if;

  for ln in
    select l.id, l.work_order_id, c.sku, c.tax_class, p.amount, p.source
      from public.work_order_lines l
      join public.work_orders w on w.id = l.work_order_id
      join public.catalog_items c on c.id = l.catalog_item_id
      cross join lateral private.customer_price(w.customer_id, l.catalog_item_id, w.market) p
     where l.catalog_item_id = new.catalog_item_id
       and w.market = new.market
       and (only_customer is null or w.customer_id = only_customer)
       and not coalesce(c.price_per_line, false)
       and w.status not in ('invoiced', 'cancelled')
       and not private.wo_invoiced(w.id)
       and not exists (select 1 from public.work_order_line_pricing x where x.line_id = l.id)
     order by l.work_order_id, l.created_at
  loop
    insert into public.work_order_line_pricing (line_id, work_order_id, customer_unit_price, price_source, tax_class)
    values (ln.id, ln.work_order_id, ln.amount, ln.source, ln.tax_class);
    perform private.log_event(ln.work_order_id, 'line_price_set', null, null,
      'Price set for ' || ln.sku || ': $' || to_char(ln.amount, 'FM999999990.00') || ' each', false);
  end loop;
  return null;
end $$;
revoke all on function private.fill_missing_line_prices() from public;

create trigger fill_missing_line_prices after insert or update of amount, effective_from, effective_to
  on public.sell_prices
  for each row execute function private.fill_missing_line_prices();

create trigger fill_missing_line_prices after insert or update of amount, effective_from, effective_to
  on public.customer_price_overrides
  for each row execute function private.fill_missing_line_prices();

-- ---------------------------------------------------------------- 4. financials

-- Same as 20261111090000_customer_items_and_line_prices.sql, plus customer_price_missing, and
-- a left join to the line prices so a line without a price still counts toward the shop
-- subtotal.
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
  coalesce(d.deductions, 0)::numeric(12,2) as shop_deductions,
  coalesce(l.price_missing, false) as customer_price_missing
from public.work_order_internal i
join public.work_orders w on w.id = i.work_order_id
left join lateral (
  select sum(p.customer_unit_price * ln.qty) as customer_subtotal,
         sum(coalesce(ln.shop_unit_rate, 0) * ln.qty) as shop_subtotal,
         bool_or(ln.shop_unit_rate is null) as rate_missing,
         bool_or(p.line_id is null) as price_missing
  from public.work_order_lines ln
  left join public.work_order_line_pricing p on p.line_id = ln.id
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
