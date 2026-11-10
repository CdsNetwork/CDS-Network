-- CDS as its own in-house shop (2026-11-10).
--
-- Why: CDS sometimes sells parts itself, with no outside shop. CDS dispatches those work
-- orders to its own shop, "CDS Inc (in-house)", completes them from that shop's login like
-- any shop, and lists them as its own sales. On those orders the amount in the shop column
-- is what CDS itself paid for the part (for a GESi filter, the GESi direct price), never a
-- regular shop rate.
--
-- 1. public.affiliates.is_in_house: true for the one in-house shop (unique partial index).
--    The shop is created here if none exists. It cannot be deactivated (its login and the
--    Review & Dispatch picker rely on it being active), and is_in_house cannot be set or
--    cleared from the app; only a migration or the service role can.
-- 2. Rates on the in-house shop: private.shop_rate_pick (new lines, re-snapshots) and
--    private.shop_rate_for count only rows with affiliate_id = the in-house shop (with this
--    customer, then any customer). Default rows and customer rows are ignored, so without an
--    in-house row the line has no rate (TBD), like an item with no rate today, or CDS types
--    the cost on the line. private.resnapshot_on_reassign re-picks every line that CDS did
--    not type (source <> 'manual') when an order moves to or from the in-house shop.
-- 3. public.cds_set_in_house_cost(item, amount): CDS sets or clears the in-house cost of an
--    item from today (a shop_rates row with affiliate_id = the in-house shop, no customer).
-- 4. public.shop_complete_work_order: on an in-house order an empty invoice/reference number
--    becomes 'IN-HOUSE-' || wo_number, so the existing check passes and the in-house login
--    is not asked for one. Every other shop still must enter one.
--
-- RLS is unchanged: the in-house login is an ordinary shop login for that affiliate (no CDS
-- rights). Other shops never read the in-house shop's rows: shop_rates rows with its
-- affiliate_id and its work orders are filtered by the existing shop_read policies.

-- ---------------------------------------------------------------- column and shop

alter table public.affiliates add column is_in_house boolean not null default false;

comment on column public.affiliates.is_in_house is
  'The one in-house shop: CDS itself selling parts. Shop pay on its orders is CDS''s own cost.';

create unique index affiliates_one_in_house on public.affiliates (is_in_house) where is_in_house;

-- CDS's own address only when the ship-from address is already set (shipping settings).
insert into public.affiliates (
  short_code, display_name, kind, market, active, is_in_house,
  address_line1, city, region, postal_code, country, hours_note
)
select 'CDS-IN-HOUSE', 'CDS Inc (in-house)', 'cds_owned', 'US', true, true,
       s.address_line1, s.city, s.region, s.postal_code, coalesce(s.country, 'US'),
       'CDS sells the part itself; no outside shop.'
from (select 1) one
left join public.shipping_settings s on s.singleton and s.address_line1 is not null
where not exists (select 1 from public.affiliates a where a.is_in_house);

-- The in-house shop stays active, and only a migration or the service role sets the flag.
create function private.guard_in_house_shop() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' and new.is_in_house then
      raise exception 'There is only one in-house shop' using errcode = 'P0001';
    end if;
    if tg_op = 'UPDATE' and new.is_in_house is distinct from old.is_in_house then
      raise exception 'The in-house shop cannot be changed into another shop' using errcode = 'P0001';
    end if;
  end if;
  if new.is_in_house and not new.active then
    raise exception 'The CDS in-house shop cannot be deactivated' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.guard_in_house_shop() from public;

create trigger guard_in_house_shop before insert or update on public.affiliates
  for each row execute function private.guard_in_house_shop();

-- True when `shop` is the in-house shop.
create function private.is_in_house_shop(shop uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.is_in_house from public.affiliates a where a.id = shop), false)
$$;
revoke all on function private.is_in_house_shop(uuid) from public;

-- The in-house shop's id (null when there is none).
create function private.in_house_shop() returns uuid
language sql stable security definer set search_path = '' as $$
  select a.id from public.affiliates a where a.is_in_house
$$;
revoke all on function private.in_house_shop() from public;

-- ---------------------------------------------------------------- resolver

-- Same as 20261110020000, plus: for the in-house shop only its own rows count (this shop
-- and this customer, then this shop); default and customer rows never apply.
create or replace function private.shop_rate_pick(item uuid, shop uuid, cust uuid, mkt public.market_code, on_date date)
returns table (amount numeric, source text)
language sql stable security definer set search_path = '' as $$
  select r.amount,
         case when r.affiliate_id is not null then 'shop'
              when r.customer_id is not null then 'customer'
              else 'default' end
  from public.shop_rates r
  where r.catalog_item_id = item and r.market = mkt
    and (r.affiliate_id is null or r.affiliate_id = shop)
    and (r.affiliate_id is not null or not private.is_in_house_shop(shop))
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

-- Same as 20261110020000, plus: never a default row for the in-house shop.
create or replace function private.shop_rate_for(item uuid, shop uuid, mkt public.market_code, on_date date)
returns numeric language sql stable security definer set search_path = '' as $$
  select r.amount from public.shop_rates r
  where r.catalog_item_id = item and r.market = mkt and r.customer_id is null
    and (r.affiliate_id = shop or (r.affiliate_id is null and not private.is_in_house_shop(shop)))
    and r.effective_from <= on_date and (r.effective_to is null or r.effective_to > on_date)
  order by (r.affiliate_id is null), r.effective_from desc
  limit 1
$$;

-- Same as 20261110020000, plus: when the order moves to or from the in-house shop, every
-- line CDS did not type (source <> 'manual') takes the new shop's pick, or no rate. A
-- default or customer rate is a regular shop rate and never stays on an in-house order,
-- and CDS's own cost never stays on an outside shop's order.
create or replace function private.resnapshot_on_reassign() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  l record;
  created_on date;
  picked_amount numeric;
  picked_source text;
  fallback_amount numeric;
  fallback_source text;
  in_house_move boolean := private.is_in_house_shop(old.affiliate_id) or private.is_in_house_shop(new.affiliate_id);
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
    if in_house_move then
      if l.shop_rate_source <> 'manual' then
        if picked_amount is null then
          select p.amount, p.source into picked_amount, picked_source
            from private.shop_rate_pick(l.catalog_item_id, new.affiliate_id, new.customer_id, new.market, private.today()) p;
        end if;
        update public.work_order_lines
           set shop_unit_rate = picked_amount,
               shop_rate_source = coalesce(picked_source, 'default')
         where id = l.id;
      end if;
    elsif picked_source = 'shop' then
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

-- ---------------------------------------------------------------- CDS cost (in-house)

-- CDS sets or clears what CDS itself pays for an item (the in-house shop's rate, any
-- customer), from today. Same history rule as cds_set_price: a change ends the current row
-- and starts a new one, a second change on the same day replaces it, null ends it.
create function public.cds_set_in_house_cost(p_catalog_item uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  today date := private.today();
  shop uuid := private.in_house_shop();
  cur_id uuid;
  cur_from date;
  cur_amount numeric;
begin
  perform private.require_cds();
  if shop is null then
    raise exception 'There is no in-house shop' using errcode = 'P0001';
  end if;
  if p_amount is not null and p_amount < 0 then
    raise exception 'A cost cannot be negative' using errcode = 'P0001';
  end if;

  select id, effective_from, amount into cur_id, cur_from, cur_amount from public.shop_rates
  where catalog_item_id = p_catalog_item and market = 'US' and affiliate_id = shop and customer_id is null
    and effective_from <= today and (effective_to is null or effective_to > today)
  order by effective_from desc limit 1 for update;

  if cur_id is not null and cur_amount is not distinct from p_amount then
    return;
  end if;
  if cur_id is not null then
    if cur_from = today then
      if p_amount is null then
        delete from public.shop_rates where id = cur_id;
      else
        update public.shop_rates set amount = p_amount where id = cur_id;
      end if;
      return;
    end if;
    update public.shop_rates set effective_to = today where id = cur_id;
  end if;
  if p_amount is null then
    return;
  end if;
  insert into public.shop_rates (catalog_item_id, market, affiliate_id, amount, effective_from)
  values (p_catalog_item, 'US', shop, p_amount, today);
end $$;
revoke all on function public.cds_set_in_house_cost(uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.cds_set_in_house_cost(uuid, numeric) to authenticated;
grant execute on function public.cds_set_in_house_cost(uuid, numeric) to service_role;

-- ---------------------------------------------------------------- completion

-- Same as 20261015000000, plus: on an in-house order an empty invoice/reference number
-- becomes 'IN-HOUSE-<wo number>'.
create or replace function public.shop_complete_work_order(p_work_order uuid, p_invoice_ref text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  c record;
  label text;
  ref text := btrim(coalesce(p_invoice_ref, ''));
begin
  perform private.shop_can_edit(wo);
  if ref = '' and private.is_in_house_shop(wo.affiliate_id) then
    ref := coalesce(nullif(btrim(wo.affiliate_invoice_ref), ''), 'IN-HOUSE-' || wo.wo_number);
  end if;
  if ref = '' then
    raise exception 'Enter your invoice or reference number' using errcode = 'P0001';
  end if;
  perform private.check_length(ref, 100);
  if not exists (
    select 1 from public.work_order_components
    where work_order_id = wo.id and (affiliate_id = wo.affiliate_id or affiliate_id is null)
  ) then
    raise exception 'Add at least one component' using errcode = 'P0001';
  end if;

  for c in select * from public.work_order_components
            where work_order_id = wo.id and (affiliate_id = wo.affiliate_id or affiliate_id is null)
            order by seq loop
    label := c.component_type::text || ' #' || c.seq;
    if c.manufacturer is null or c.part_number is null or c.serial_number is null then
      raise exception '%: manufacturer, part number and serial number are required', label using errcode = 'P0001';
    end if;
    if c.result is null then
      raise exception '%: choose a result', label using errcode = 'P0001';
    end if;
    if c.component_type in ('DPF', 'DOC') and (
         c.dp_before is null or c.dp_after is null or c.weight_before_g is null or c.weight_after_g is null) then
      raise exception '%: pressure before and after, and weight before and after (grams) are required', label
        using errcode = 'P0001';
    end if;
    if c.result in ('failed', 'condemned') and not exists (
         select 1 from public.attachments a where a.component_id = c.id) then
      raise exception '%: add a photo for a failed or condemned part', label using errcode = 'P0001';
    end if;
  end loop;

  if exists (
    select 1 from public.authorization_requests
    where work_order_id = wo.id and status = 'pending'
      and (affiliate_id = wo.affiliate_id or affiliate_id is null)
  ) then
    raise exception 'An extra work request is still waiting for CDS' using errcode = 'P0001';
  end if;

  update public.work_orders
     set status = 'completed', completed_at = now(), affiliate_invoice_ref = ref,
         shop_ship_status = case when fulfillment = 'shipping' then 'ready_to_ship' else shop_ship_status end
   where id = wo.id;
  perform private.log_event(wo.id, 'complete', wo.status, 'completed', 'Completed by shop', true);
end $$;
