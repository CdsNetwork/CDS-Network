-- Emails to shops (Sarah, CDS, 2026-11-19): notices and reminders to a shop's own contacts.
--
-- 1. affiliates.shop_emails_enabled: "Email this shop about its jobs", off for every shop at
--    first, changed by CDS only (affiliates has no shop write policy). shop_emails_enabled_at
--    is when it was last turned on (kept by a trigger, null while off): reminders count from
--    then, so turning a shop on never sends a burst of reminders about old orders. CDS's
--    in-house shop is never emailed: it cannot be turned on.
-- 2. public.shop_emails: one row per email to a shop, its outbox, dedupe record and history.
--    dedupe_key is unique, so a notice or a reminder is recorded once whatever reruns. CDS
--    reads it (the "Emails to shop" box on the work order page); shops read nothing of it.
--    The service role (the sender, src/lib/shop-email-run.ts) writes it.
-- 3. Notices are queued by triggers, so every way CDS makes the change queues it, and only
--    while the order's shop has emails on:
--      dispatch             the order is sent to a shop (status becomes awaiting_acceptance,
--                           or the shop changes while awaiting acceptance),
--      extra_work_approved  CDS decides a shop's extra work request,
--      extra_work_declined
--      note                 a CDS note the shop sees (work_order_notes; never the CDS-only
--                           work_order_internal_notes), on an order the shop has,
--      lines                CDS adds, removes or changes a service or part line while the
--                           shop works the order. Debounced: changes within 3 minutes of the
--                           last one (at most 15 minutes after the first) are one email.
--    A failure to queue never blocks the change itself (logged as a warning).
-- 4. public.shop_email_claim(id, max attempts) (service role): takes one due row for sending,
--    atomically, so two runs never send the same row.
-- 5. public.shop_email_reminder_candidates() (service role): the open orders of shops with
--    emails on, with the times the reminder rules need (src/lib/shop-email-reminders.ts),
--    including the last shop update: the latest of
--      * a work order event logged by a shop login (accept, status change, ship status,
--        pickup ETA change, part added or removed, extra work request, completion),
--      * a note by a shop login, a file uploaded by a shop login,
--      * a component saved by a shop login (work_order_components.updated_by),
--      * a line added by a shop login, an extra work request by a shop login.
-- tests/rls/grants.snapshot.json lists the new table, sequence and functions.

-- ---------------------------------------------------------------- 1. the per-shop switch

alter table public.affiliates
  add column shop_emails_enabled boolean not null default false,
  add column shop_emails_enabled_at timestamptz;

create function private.shop_emails_switch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.is_in_house and new.shop_emails_enabled then
    if tg_op = 'UPDATE' and old.is_in_house then
      raise exception 'CDS''s in-house shop is never emailed' using errcode = 'P0001';
    end if;
    new.shop_emails_enabled := false;
  end if;
  if not new.shop_emails_enabled then
    new.shop_emails_enabled_at := null;
  elsif tg_op = 'INSERT' or not old.shop_emails_enabled then
    new.shop_emails_enabled_at := now();
  else
    new.shop_emails_enabled_at := old.shop_emails_enabled_at;
  end if;
  return new;
end $$;
revoke all on function private.shop_emails_switch() from public;

create trigger shop_emails_switch before insert or update on public.affiliates
  for each row execute function private.shop_emails_switch();

-- ---------------------------------------------------------------- 2. the outbox and history

create table public.shop_emails (
  id bigint generated always as identity primary key,
  work_order_id uuid not null references public.work_orders on delete cascade,
  affiliate_id uuid not null references public.affiliates on delete cascade,
  kind text not null check (kind in (
    'dispatch', 'extra_work_approved', 'extra_work_declined', 'note', 'lines',
    'not_accepted', 'no_update', 'not_completed'
  )),
  dedupe_key text not null unique check (char_length(dedupe_key) <= 300),
  -- The note or extra work request a notice is about.
  ref_id uuid,
  -- Reminders: when the reminder's clock started (dispatch, acceptance, last update or arrival).
  since timestamptz,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'error')),
  send_after timestamptz not null default now(),
  attempts integer not null default 0,
  attempted_at timestamptz,
  recipients text[] not null default '{}',
  subject text,
  provider_id text,
  -- Why it was skipped or failed.
  note text check (char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index shop_emails_order on public.shop_emails (work_order_id, created_at);
create index shop_emails_open on public.shop_emails (send_after) where status in ('pending', 'sending', 'error');
-- One open debounced line change email per order and shop.
create unique index shop_emails_lines_pending on public.shop_emails (work_order_id, affiliate_id)
  where kind = 'lines' and status = 'pending';

alter table public.shop_emails enable row level security;
create policy cds_read on public.shop_emails for select to authenticated
  using ((select private.is_cds()));

revoke all on table public.shop_emails from public, anon, authenticated, service_role;
grant select on table public.shop_emails to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shop_emails to service_role;
revoke all on sequence public.shop_emails_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.shop_emails_id_seq to service_role;

-- ---------------------------------------------------------------- 3. queueing notices

-- Queues a notice to the order's shop when the shop has emails on, the order is in one of the
-- statuses and (p_affiliate given) still with that shop. Never raises.
create function private.queue_shop_email(
  p_work_order uuid, p_kind text, p_key text, p_ref uuid, p_statuses public.wo_status[], p_affiliate uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  shop uuid;
begin
  select o.affiliate_id into shop
    from public.work_orders o
    join public.affiliates a on a.id = o.affiliate_id
   where o.id = p_work_order
     and a.shop_emails_enabled and not a.is_in_house and a.active
     and o.status = any (p_statuses)
     and (p_affiliate is null or o.affiliate_id = p_affiliate);
  if shop is null then
    return;
  end if;
  if p_kind = 'lines' then
    insert into public.shop_emails (work_order_id, affiliate_id, kind, dedupe_key, send_after)
    values (p_work_order, shop, 'lines', 'lines:' || p_work_order || ':' || gen_random_uuid(), now() + interval '3 minutes')
    on conflict (work_order_id, affiliate_id) where kind = 'lines' and status = 'pending'
    do update set send_after = least(now() + interval '3 minutes', public.shop_emails.created_at + interval '15 minutes');
  else
    insert into public.shop_emails (work_order_id, affiliate_id, kind, dedupe_key, ref_id)
    values (p_work_order, shop, p_kind, p_key, p_ref)
    on conflict (dedupe_key) do nothing;
  end if;
exception when others then
  raise warning 'Shop email (%) not queued for work order %: %', p_kind, p_work_order, sqlerrm;
end $$;
revoke all on function private.queue_shop_email(uuid, text, text, uuid, public.wo_status[], uuid) from public;

-- The order was sent to a shop.
create function private.shop_email_dispatch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'awaiting_acceptance' and new.affiliate_id is not null
     and (tg_op = 'INSERT' or old.status is distinct from new.status or old.affiliate_id is distinct from new.affiliate_id) then
    perform private.queue_shop_email(
      new.id, 'dispatch',
      'dispatch:' || new.id || ':' || new.affiliate_id || ':' || extract(epoch from coalesce(new.dispatched_at, now()))::text,
      null, array['awaiting_acceptance']::public.wo_status[], new.affiliate_id);
  end if;
  return null;
end $$;
revoke all on function private.shop_email_dispatch() from public;

create trigger shop_email_dispatch after insert or update of status, affiliate_id on public.work_orders
  for each row execute function private.shop_email_dispatch();

-- CDS decided an extra work request of the order's current shop.
create function private.shop_email_extra_work() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  kind text := case new.status when 'approved' then 'extra_work_approved' else 'extra_work_declined' end;
  shop uuid;
begin
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    shop := coalesce(new.affiliate_id, (select o.affiliate_id from public.work_orders o where o.id = new.work_order_id));
    perform private.queue_shop_email(
      new.work_order_id, kind, 'extra_work:' || new.id || ':' || new.status, new.id,
      array['awaiting_acceptance', 'accepted', 'picked_up', 'in_process', 'completed']::public.wo_status[], shop);
  end if;
  return null;
end $$;
revoke all on function private.shop_email_extra_work() from public;

create trigger shop_email_extra_work after update of status on public.authorization_requests
  for each row execute function private.shop_email_extra_work();

-- A note by CDS that the order's shop sees (work_order_notes; the shop sees notes stamped with
-- its own shop or none, see the shop_read policy).
create function private.shop_email_note() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles p where p.id = new.author_id and p.kind = 'cds') then
    perform private.queue_shop_email(
      new.work_order_id, 'note', 'note:' || new.id, new.id,
      array['awaiting_acceptance', 'accepted', 'picked_up', 'in_process', 'completed']::public.wo_status[], new.affiliate_id);
  end if;
  return null;
end $$;
revoke all on function private.shop_email_note() from public;

create trigger shop_email_note after insert on public.work_order_notes
  for each row execute function private.shop_email_note();

-- CDS changed the services or parts while the shop works the order. Only CDS's own direct
-- changes (pg_trigger_depth() = 1): not the shop rates repriced by a reassignment, not lines
-- removed with a deleted order, not the line an approved extra work request adds (that has its
-- own notice).
create function private.shop_email_lines() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo uuid := coalesce(new.work_order_id, old.work_order_id);
begin
  if pg_trigger_depth() > 1 or not private.is_cds() then
    return null;
  end if;
  if tg_op = 'INSERT' and new.origin = 'auth_request' then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.qty is not distinct from old.qty
     and new.catalog_item_id is not distinct from old.catalog_item_id
     and new.description is not distinct from old.description
     and new.shop_unit_rate is not distinct from old.shop_unit_rate then
    return null;
  end if;
  perform private.queue_shop_email(
    wo, 'lines', null, null, array['awaiting_acceptance', 'accepted', 'picked_up', 'in_process']::public.wo_status[], null);
  return null;
end $$;
revoke all on function private.shop_email_lines() from public;

create trigger shop_email_lines after insert or update or delete on public.work_order_lines
  for each row execute function private.shop_email_lines();

-- ---------------------------------------------------------------- 4. claiming a row to send

-- Takes a due row for sending: pending, or failed fewer than p_max_attempts times within a day,
-- or abandoned while sending for 5 minutes. True for one caller only.
create function public.shop_email_claim(p_id bigint, p_max_attempts integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.shop_emails
     set status = 'sending', attempts = attempts + 1, attempted_at = now()
   where id = p_id
     and send_after <= now()
     and (status = 'pending'
          or (status = 'error' and attempts < p_max_attempts and created_at > now() - interval '24 hours')
          or (status = 'sending' and attempts < p_max_attempts and attempted_at < now() - interval '5 minutes'));
  return found;
end $$;
revoke all on function public.shop_email_claim(bigint, integer) from public, anon, authenticated, service_role;
grant execute on function public.shop_email_claim(bigint, integer) to service_role;

-- ---------------------------------------------------------------- 5. reminder inputs

create function public.shop_email_reminder_candidates()
returns table (
  work_order_id uuid,
  affiliate_id uuid,
  status public.wo_status,
  fulfillment public.fulfillment_method,
  enabled_at timestamptz,
  dispatched_at timestamptz,
  accepted_at timestamptz,
  picked_up_at timestamptz,
  arrived_at timestamptz,
  last_shop_update_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select o.id, o.affiliate_id, o.status, o.fulfillment, a.shop_emails_enabled_at,
         o.dispatched_at, o.accepted_at, o.picked_up_at,
         (select min(s.delivered_at) from public.shipments s
           where s.work_order_id = o.id and s.direction = 'customer_to_affiliate' and s.delivered_at is not null),
         greatest(
           (select max(e.at) from public.work_order_events e join public.profiles p on p.id = e.actor_id
             where e.work_order_id = o.id and p.kind = 'shop'),
           (select max(n.created_at) from public.work_order_notes n join public.profiles p on p.id = n.author_id
             where n.work_order_id = o.id and p.kind = 'shop'),
           (select max(f.uploaded_at) from public.attachments f join public.profiles p on p.id = f.uploaded_by
             where f.work_order_id = o.id and p.kind = 'shop'),
           (select max(c.updated_at) from public.work_order_components c join public.profiles p on p.id = c.updated_by
             where c.work_order_id = o.id and p.kind = 'shop'),
           (select max(l.created_at) from public.work_order_lines l join public.profiles p on p.id = l.added_by
             where l.work_order_id = o.id and p.kind = 'shop'),
           (select max(r.requested_at) from public.authorization_requests r join public.profiles p on p.id = r.requested_by
             where r.work_order_id = o.id and p.kind = 'shop')
         )
    from public.work_orders o
    join public.affiliates a on a.id = o.affiliate_id
   where a.shop_emails_enabled and not a.is_in_house and a.active
     and o.status in ('awaiting_acceptance', 'accepted', 'picked_up', 'in_process')
$$;
revoke all on function public.shop_email_reminder_candidates() from public, anon, authenticated, service_role;
grant execute on function public.shop_email_reminder_candidates() to service_role;
