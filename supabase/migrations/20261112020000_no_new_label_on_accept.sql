-- No "New from shop" mark when a shop accepts a job (CDS, 2026-11-12).
--
-- Why: the acceptance email with the ETA already reaches dispatch@ (src/lib/portal-email.ts,
-- keyed on the 'accept' event, not on this mark), so marking the order as well is noise. The
-- mark stays for shop notes, files and failures (20261111040000_shop_updates.sql).
--
-- private.shop_accept_activity: same as 20261111080000_shop_accept_activity.sql, except that
-- the accept (status awaiting_acceptance to accepted) records nothing. The accept sets the
-- pickup window in the same update, so that change records no 'eta' either. A shop's later
-- change of the pickup window, status unchanged, still records 'eta'.

create or replace function private.shop_accept_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_shop_login(auth.uid()) then
    return null;
  end if;
  if new.status = 'accepted' and old.status = 'awaiting_acceptance' then
    return null;
  end if;
  if new.pickup_window is not null and new.pickup_window is distinct from old.pickup_window then
    perform private.record_shop_activity(new.id, 'eta');
  end if;
  return null;
end $$;
revoke all on function private.shop_accept_activity() from public;
