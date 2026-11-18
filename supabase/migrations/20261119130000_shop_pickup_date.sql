-- Pickup day (Clyde, CDS, 2026-11-18): the shop calendar shows a pickup job on "the time/date
-- they choose". Until now a shop accepting a pickup job chose only a window
-- (public.pickup_window), no day.
--
-- 1. work_orders.pickup_date (date, nullable): the day the shop picks the part up. Orders
--    accepted before this migration have no day. Shops and CDS read it like every other
--    work_orders column (table grants and RLS unchanged).
-- 2. public.shop_accept_work_order gains p_pickup_date. A pickup job needs both the day and the
--    window; the day is a Pacific date (private.today()), not in the past and at most a year
--    out. 'tomorrow' (20261119030000_pickup_window_tomorrow.sql) is no longer a choice: the shop
--    picks tomorrow's date instead. The enum value stays for the orders that have it. Shipped
--    jobs are accepted as before, without a day.
-- 3. public.shop_set_pickup: the shop changes the day and window of its accepted pickup job
--    until it is picked up (status 'accepted'). Logged as a shop-visible 'pickup_eta' event.
-- 4. A day only exists with a window: when the window is cleared (decline, CDS) the day is
--    cleared too (trigger private.pickup_date_needs_window).
-- 5. "New from shop" ('eta'): a shop's later change of the day, like a change of the window,
--    flags the order (private.shop_accept_activity, last in 20261112020000_no_new_label_on_accept.sql;
--    the accept itself still flags nothing).
--
-- Grants: shop_accept_work_order(uuid, public.pickup_window) is replaced by
-- shop_accept_work_order(uuid, public.pickup_window, date); it and shop_set_pickup(uuid, date,
-- public.pickup_window) are executable by authenticated and service_role, as the other shop
-- functions (tests/rls/grants.snapshot.json).

alter table public.work_orders add column pickup_date date;
comment on column public.work_orders.pickup_date is
  'Pacific day the shop picks the part up (pickup jobs), chosen with pickup_window. Null before 2026-11-19.';

-- ---------------------------------------------------------------- day only with a window

create function private.pickup_date_needs_window() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.pickup_window is null then
    new.pickup_date := null;
  end if;
  return new;
end $$;
revoke all on function private.pickup_date_needs_window() from public;

create trigger pickup_date_needs_window before insert or update of pickup_window, pickup_date on public.work_orders
  for each row execute function private.pickup_date_needs_window();

-- ---------------------------------------------------------------- the shop's choice

-- Raises when a pickup day and window cannot be saved. Same rules as src/lib/pickup.ts.
create function private.check_pickup_choice(p_window public.pickup_window, p_date date) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_date is null then
    raise exception 'Choose the pickup day.' using errcode = 'P0001';
  end if;
  if p_window is null or p_window = 'tomorrow' then
    raise exception 'Choose a pickup window.' using errcode = 'P0001';
  end if;
  if p_date < private.today() then
    raise exception 'The pickup day cannot be in the past.' using errcode = 'P0001';
  end if;
  if p_date > private.today() + 365 then
    raise exception 'Choose a pickup day within the next year.' using errcode = 'P0001';
  end if;
end $$;
revoke all on function private.check_pickup_choice(public.pickup_window, date) from public;

drop function public.shop_accept_work_order(uuid, public.pickup_window);

create function public.shop_accept_work_order(
  p_work_order uuid, p_pickup_window public.pickup_window default null, p_pickup_date date default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  if wo.status <> 'awaiting_acceptance' then
    raise exception 'This job is not waiting for acceptance' using errcode = 'P0001';
  end if;
  if wo.fulfillment = 'pickup' then
    if p_pickup_window is null or p_pickup_date is null then
      raise exception 'Choose the pickup day and pickup window to accept a pickup job' using errcode = 'P0001';
    end if;
    perform private.check_pickup_choice(p_pickup_window, p_pickup_date);
  end if;
  update public.work_orders
     set status = 'accepted', accepted_at = now(), pickup_window = coalesce(p_pickup_window, pickup_window),
         pickup_date = case when fulfillment = 'pickup' then p_pickup_date else pickup_date end,
         shop_ship_status = case when fulfillment = 'shipping' then 'awaiting_delivery' else shop_ship_status end
   where id = wo.id;
  perform private.log_event(wo.id, 'accept', wo.status, 'accepted', 'Accepted by shop', true);
end $$;

-- The shop moves the pickup of its accepted pickup job (not yet picked up).
create function public.shop_set_pickup(p_work_order uuid, p_pickup_date date, p_pickup_window public.pickup_window)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  if wo.fulfillment <> 'pickup' then
    raise exception 'Only a pickup job has a pickup day' using errcode = 'P0001';
  end if;
  if wo.status <> 'accepted' then
    raise exception 'The pickup can only change until the part is picked up' using errcode = 'P0001';
  end if;
  perform private.check_pickup_choice(p_pickup_window, p_pickup_date);
  if wo.pickup_date is not distinct from p_pickup_date and wo.pickup_window is not distinct from p_pickup_window then
    return;
  end if;
  update public.work_orders set pickup_date = p_pickup_date, pickup_window = p_pickup_window where id = wo.id;
  perform private.log_event(wo.id, 'pickup_eta', wo.status, wo.status,
    'Pickup changed by shop to ' || to_char(p_pickup_date, 'YYYY-MM-DD') || ', ' || p_pickup_window::text, true);
end $$;

-- ---------------------------------------------------------------- New from shop

create or replace function private.shop_accept_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_shop_login(auth.uid()) then
    return null;
  end if;
  if new.status = 'accepted' and old.status = 'awaiting_acceptance' then
    return null;
  end if;
  if (new.pickup_window is not null and new.pickup_window is distinct from old.pickup_window)
     or (new.pickup_date is not null and new.pickup_date is distinct from old.pickup_date) then
    perform private.record_shop_activity(new.id, 'eta');
  end if;
  return null;
end $$;
revoke all on function private.shop_accept_activity() from public;

drop trigger shop_activity on public.work_orders;
create trigger shop_activity after update of status, pickup_window, pickup_date on public.work_orders
  for each row execute function private.shop_accept_activity();

-- ---------------------------------------------------------------- grants

revoke all on function public.shop_accept_work_order(uuid, public.pickup_window, date) from public, anon, authenticated, service_role;
grant execute on function public.shop_accept_work_order(uuid, public.pickup_window, date) to authenticated;
grant execute on function public.shop_accept_work_order(uuid, public.pickup_window, date) to service_role;

revoke all on function public.shop_set_pickup(uuid, date, public.pickup_window) from public, anon, authenticated, service_role;
grant execute on function public.shop_set_pickup(uuid, date, public.pickup_window) to authenticated;
grant execute on function public.shop_set_pickup(uuid, date, public.pickup_window) to service_role;
