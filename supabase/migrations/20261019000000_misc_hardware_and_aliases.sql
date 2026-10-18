-- Misc. hardware lines and customer descriptions for customer part numbers (2026-10-19).
--
-- 1. Items priced per line (catalog_items.price_per_line). Misc. hardware (CDS confirmed
--    2026-10-16): bolts and nuts that go with kits. Only on an order when the shop's
--    invoice includes them; CDS enters the amount from the shop's invoice, the shop is paid
--    that amount and the customer is billed the same amount (no upcharge, margin 0), taxed
--    as parts. On the QuickBooks invoice it is an ordinary line on the item mapped to the
--    catalog item (CDS's QuickBooks item "MISC PART", mapped on Admin > QuickBooks mappings).
--      * work_order_lines.description: the text CDS enters on the line. Lines are visible
--        to shops, so the description is too; the customer price stays in
--        work_order_line_pricing (CDS only). The shop's pay (shop_unit_rate) is the amount
--        from its own invoice.
--      * public.cds_add_pass_through_line / public.cds_remove_pass_through_line (CDS only):
--        add or remove such a line until the order is invoiced (the shop's invoice arrives
--        when the work is completed, after ordinary lines are fixed).
--      * The line triggers: such a line needs a rate CDS typed in (shops can never add
--        one), and the customer price is that same amount.
-- 2. customer_item_aliases.customer_description: the customer's own description for the
--    item (First Student's Basware portal matches part numbers; the invoice shows the part
--    number with this description). CDS only, like the rest of the table.

-- ---------------------------------------------------------------- items priced per line

alter table public.catalog_items
  add column price_per_line boolean not null default false;

comment on column public.catalog_items.price_per_line is
  'The amount is entered on each line (Misc. hardware): shop rate = customer price = that amount.';

-- Not offered to shops (shop_selectable false), so shops cannot add it as a part.
insert into public.catalog_items (sku, category, name, tax_class, shop_selectable, active, price_per_line)
values ('CDS-MISC-HARDWARE', 'part', 'Misc. hardware', 'parts', false, true, true)
on conflict (sku) do update
  set price_per_line = true, shop_selectable = false, tax_class = 'parts';

alter table public.work_order_lines
  add column description text
    constraint work_order_lines_description_check
    check (description is null or (btrim(description) <> '' and char_length(description) <= 500));

-- Same as 20261015030000, plus: an item priced per line needs the amount CDS typed in.
create or replace function private.snapshot_shop_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  own numeric;
  per_line boolean;
begin
  select w.affiliate_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
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

-- Same as 20261015030000, plus: an item priced per line is billed at the amount entered on
-- the line (the shop rate), with no upcharge.
create or replace function private.write_line_pricing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  item_class public.tax_class;
  per_line boolean;
  price numeric(12,2);
  src public.price_source := 'customer_override';
  today date := private.today();
begin
  select w.customer_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  select c.tax_class, c.price_per_line into item_class, per_line from public.catalog_items c where c.id = new.catalog_item_id;

  if coalesce(per_line, false) then
    insert into public.work_order_line_pricing (line_id, work_order_id, customer_unit_price, price_source, tax_class)
    values (new.id, new.work_order_id, new.shop_unit_rate, 'manual', item_class);
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

-- Adds a line for an item priced per line (Misc. hardware): qty 1, the amount from the
-- shop's invoice as both the shop's pay and the customer price. Until the order is invoiced.
create function public.cds_add_pass_through_line(
  p_work_order uuid, p_catalog_item uuid, p_description text, p_amount numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  item public.catalog_items;
  text_in text := btrim(coalesce(p_description, ''));
  line uuid;
begin
  perform private.require_cds();
  if text_in = '' then
    raise exception 'Enter a description' using errcode = 'P0001';
  end if;
  perform private.check_length(text_in, 500);
  if p_amount is null or p_amount <= 0 or p_amount > 99999.99 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter the amount from the shop''s invoice in dollars and cents' using errcode = 'P0001';
  end if;

  select * into item from public.catalog_items c where c.id = p_catalog_item;
  if not found or not item.price_per_line or not item.active then
    raise exception 'This item is not priced per line' using errcode = 'P0001';
  end if;

  select * into wo from public.work_orders w where w.id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status in ('invoiced', 'cancelled') then
    raise exception 'Lines cannot change once the work order is invoiced or cancelled' using errcode = 'P0001';
  end if;

  insert into public.work_order_lines (work_order_id, catalog_item_id, qty, shop_unit_rate, origin, description)
  values (wo.id, item.id, 1, p_amount, 'cds_order', text_in)
  returning id into line;
  perform private.log_event(wo.id, 'line_added', null, null, 'CDS added ' || item.name || ': ' || text_in,
    wo.status not in ('pending_review', 'rejected_by_affiliate'));
  return line;
end $$;

-- Removes such a line (a typo in the amount, or the shop's invoice changed). Until invoiced.
create function public.cds_remove_pass_through_line(p_line uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  ln record;
begin
  perform private.require_cds();
  select l.id, l.work_order_id, l.description, c.name, c.price_per_line into ln
    from public.work_order_lines l join public.catalog_items c on c.id = l.catalog_item_id
   where l.id = p_line;
  if not found or not ln.price_per_line then
    raise exception 'Line not found' using errcode = 'P0002';
  end if;
  select * into wo from public.work_orders w where w.id = ln.work_order_id for update;
  if wo.status in ('invoiced', 'cancelled') then
    raise exception 'Lines cannot change once the work order is invoiced or cancelled' using errcode = 'P0001';
  end if;
  delete from public.work_order_lines where id = ln.id;
  perform private.log_event(wo.id, 'line_removed', null, null,
    'CDS removed ' || ln.name || coalesce(': ' || ln.description, ''),
    wo.status not in ('pending_review', 'rejected_by_affiliate'));
end $$;

revoke all on function public.cds_add_pass_through_line(uuid, uuid, text, numeric) from public, anon;
grant execute on function public.cds_add_pass_through_line(uuid, uuid, text, numeric) to authenticated;
revoke all on function public.cds_remove_pass_through_line(uuid) from public, anon;
grant execute on function public.cds_remove_pass_through_line(uuid) to authenticated;

-- ---------------------------------------------------------------- customer descriptions

alter table public.customer_item_aliases
  add column customer_description text
    constraint customer_item_aliases_customer_description_check
    check (customer_description is null or (btrim(customer_description) <> '' and char_length(customer_description) <= 500));
