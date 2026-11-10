-- Shop updates flag (Ashley, 2026-11-11, point 8): WO 101924 failed, the shop added notes and
-- photos about it, but CDS's work order list still only said "in process".
--
-- A work order is "New from shop" when its shop did something CDS has not looked at yet:
--   * added a shared note (work_order_notes, author is a shop login),
--   * uploaded a file (attachments, uploader is a shop login; CDS's own uploads never count,
--     they also carry no shop stamp, see private.stamp_affiliate in 20261110050000),
--   * marked a component failed or condemned (work_order_components.result changed to one of
--     those by a shop login, which is what shop_save_component writes as updated_by).
-- CDS opening the work order page clears the flag (public.cds_mark_work_order_seen). The flag
-- is per work order, not per CDS user: dispatch works one shared queue.
--
-- work_order_shop_activity holds one row per work order that ever had shop activity or was
-- cleared. is_new is computed from the two times, so the list can filter on it.
-- component_failures keeps one row per failure (a component moving into failed or condemned):
-- the dispatch@ email for a failure is keyed on its id, so each failure is emailed once.
--
-- Both tables are CDS only: shops never see when or whether CDS looked at their work. Nobody
-- writes them through the API; the triggers and the function below do (security definer).

create table public.work_order_shop_activity (
  work_order_id uuid primary key references public.work_orders on delete cascade,
  shop_activity_at timestamptz,
  -- What the shop did last: note, file or failed.
  shop_activity text check (shop_activity in ('note', 'file', 'failed')),
  cds_viewed_at timestamptz,
  cds_viewed_by uuid references public.profiles on delete set null,
  is_new boolean generated always as (
    shop_activity_at is not null and (cds_viewed_at is null or shop_activity_at > cds_viewed_at)
  ) stored
);
create index work_order_shop_activity_new on public.work_order_shop_activity (work_order_id) where is_new;

create table public.component_failures (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders on delete cascade,
  component_id uuid references public.work_order_components on delete set null,
  affiliate_id uuid references public.affiliates,
  component_type public.component_type not null,
  manufacturer text,
  part_number text,
  serial_number text,
  result public.component_result not null check (result in ('failed', 'condemned')),
  result_note text,
  failed_by uuid references public.profiles on delete set null,
  at timestamptz not null default now()
);
create index on public.component_failures (work_order_id, at);
create index on public.component_failures (component_id, at);

-- ---------------------------------------------------------------- recording shop activity

create function private.record_shop_activity(p_work_order uuid, p_kind text) returns void
language sql security definer set search_path = '' as $$
  insert into public.work_order_shop_activity (work_order_id, shop_activity_at, shop_activity)
  values (p_work_order, now(), p_kind)
  on conflict (work_order_id) do update
    set shop_activity_at = excluded.shop_activity_at, shop_activity = excluded.shop_activity
$$;
revoke all on function private.record_shop_activity(uuid, text) from public;

create function private.is_shop_login(p_profile uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.kind = 'shop' from public.profiles p where p.id = p_profile), false)
$$;
revoke all on function private.is_shop_login(uuid) from public;

create function private.shop_note_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.is_shop_login(new.author_id) then
    perform private.record_shop_activity(new.work_order_id, 'note');
  end if;
  return null;
end $$;
revoke all on function private.shop_note_activity() from public;

create trigger shop_activity after insert on public.work_order_notes
  for each row execute function private.shop_note_activity();

create function private.shop_file_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.is_shop_login(new.uploaded_by) then
    perform private.record_shop_activity(new.work_order_id, 'file');
  end if;
  return null;
end $$;
revoke all on function private.shop_file_activity() from public;

create trigger shop_activity after insert on public.attachments
  for each row execute function private.shop_file_activity();

create function private.shop_failure_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.result in ('failed', 'condemned')
     and (tg_op = 'INSERT' or old.result is distinct from new.result)
     and private.is_shop_login(new.updated_by) then
    insert into public.component_failures
      (work_order_id, component_id, affiliate_id, component_type, manufacturer, part_number, serial_number,
       result, result_note, failed_by)
    values
      (new.work_order_id, new.id, new.affiliate_id, new.component_type, new.manufacturer, new.part_number,
       new.serial_number, new.result, new.result_note, new.updated_by);
    perform private.record_shop_activity(new.work_order_id, 'failed');
  end if;
  return null;
end $$;
revoke all on function private.shop_failure_activity() from public;

create trigger shop_activity after insert or update of result on public.work_order_components
  for each row execute function private.shop_failure_activity();

-- ---------------------------------------------------------------- CDS opened the work order

-- Writes only when there is something to clear, so opening a work order is normally a read.
create function public.cds_mark_work_order_seen(p_work_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_cds();
  update public.work_order_shop_activity
     set cds_viewed_at = now(), cds_viewed_by = auth.uid()
   where work_order_id = p_work_order and is_new;
end $$;
revoke all on function public.cds_mark_work_order_seen(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_mark_work_order_seen(uuid) to authenticated;
grant execute on function public.cds_mark_work_order_seen(uuid) to service_role;

-- ---------------------------------------------------------------- access: CDS reads, nobody writes

alter table public.work_order_shop_activity enable row level security;
alter table public.component_failures enable row level security;

create policy cds_read on public.work_order_shop_activity for select to authenticated
  using ((select private.is_cds()));
create policy cds_read on public.component_failures for select to authenticated
  using ((select private.is_cds()));

-- Grants (20261020000000_explicit_api_grants.sql).
revoke all on table public.work_order_shop_activity from public, anon, authenticated, service_role;
grant select on table public.work_order_shop_activity to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_shop_activity to service_role;

revoke all on table public.component_failures from public, anon, authenticated, service_role;
grant select on table public.component_failures to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.component_failures to service_role;
