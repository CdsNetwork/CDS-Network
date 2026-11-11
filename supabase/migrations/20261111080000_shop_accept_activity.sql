-- Shop accepts a job, or changes its pickup ETA (CDS, 2026-11-11): the work order gets the same
-- "New from shop" mark as a shop note, file or failure (20261111040000_shop_updates.sql), and
-- the app emails dispatch@ about the acceptance with the ETA (src/lib/portal-email.ts).
--
-- Two more kinds of shop activity:
--   'accepted'  the shop accepted the job (status awaiting_acceptance to accepted),
--   'eta'       the shop changed the pickup window of a job it already has.
-- Today a shop sets the pickup window only when accepting (public.shop_accept_work_order);
-- there is no shop function that changes it later. The trigger reacts to any change a shop
-- login makes, so a future one is covered without another migration. CDS's own changes to
-- the status or the pickup window never flag the order.

alter table public.work_order_shop_activity drop constraint work_order_shop_activity_shop_activity_check;
alter table public.work_order_shop_activity add constraint work_order_shop_activity_shop_activity_check
  check (shop_activity in ('note', 'file', 'failed', 'accepted', 'eta'));

-- Shops change work_orders only through security definer functions; auth.uid() is still the
-- shop login inside them.
create function private.shop_accept_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_shop_login(auth.uid()) then
    return null;
  end if;
  if new.status = 'accepted' and old.status = 'awaiting_acceptance' then
    perform private.record_shop_activity(new.id, 'accepted');
  elsif new.pickup_window is not null and new.pickup_window is distinct from old.pickup_window then
    perform private.record_shop_activity(new.id, 'eta');
  end if;
  return null;
end $$;
revoke all on function private.shop_accept_activity() from public;

create trigger shop_activity after update of status, pickup_window on public.work_orders
  for each row execute function private.shop_accept_activity();
