-- Carrier pickups for shipment labels (CDS asked 2026-11-10: "there is no option to schedule
-- a pick up for the shipment").
--
-- CDS dispatch books a carrier pickup for a leg that has a real label in use (ShipStation
-- POST /v2/pickups with the label id). The carrier collects at the label's ship-from
-- address. The portal keeps the confirmation number and the window CDS asked for, and CDS
-- can cancel the pickup (DELETE /v2/pickups/{pickup_id}).
--
-- * CDS only, like label costs: shops never see pickups. Written only by the cds_ functions
--   below, after ShipStation booked or cancelled the pickup.
-- * One scheduled pickup per label at a time. A label with a scheduled pickup cannot be
--   voided: the pickup is cancelled first.
-- * window_start and window_end are the ready and close times CDS typed, local to the
--   pickup address (time_zone, an IANA zone such as America/Phoenix).

create table public.shipment_pickups (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments on delete cascade,
  label_id uuid not null references public.shipment_labels on delete cascade,
  -- For example pik_3YcKU5zdtJuCqoeNwyqqbW.
  shipstation_pickup_id text not null unique check (char_length(shipstation_pickup_id) <= 60),
  confirmation_number text check (char_length(confirmation_number) <= 100),
  shipstation_carrier_id text not null check (char_length(shipstation_carrier_id) <= 40),
  carrier text not null check (carrier in ('UPS', 'FedEx', 'USPS', 'Other')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  time_zone text not null check (char_length(time_zone) <= 60),
  notes text check (char_length(notes) <= 500),
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  created_by uuid references public.profiles on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles on delete set null,
  constraint shipment_pickups_window check (window_end > window_start)
);
-- One pickup at a time per label: cancel it before booking another.
create unique index shipment_pickups_one_scheduled on public.shipment_pickups (label_id) where status = 'scheduled';
create index on public.shipment_pickups (shipment_id);

alter table public.shipment_pickups enable row level security;
create policy cds_read on public.shipment_pickups for select to authenticated
  using ((select private.is_cds()));

create trigger audit after insert or update or delete on public.shipment_pickups
  for each row execute function private.audit();

-- Grants (20261020000000_explicit_api_grants.sql), the same as shipment_labels: read only
-- for signed-in users (and only CDS by the policy), writes through the functions below.
revoke all on table public.shipment_pickups from public, anon, authenticated, service_role;
grant maintain, select on table public.shipment_pickups to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipment_pickups to service_role;

-- ---------------------------------------------------------------- record a pickup (CDS)

-- Records a pickup ShipStation just booked for an active label.
-- p_pickup keys: shipstation_pickup_id, confirmation_number, window_start, window_end,
-- time_zone, notes.
create function public.cds_record_shipment_pickup(p_label uuid, p_pickup jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  l public.shipment_labels;
  new_pickup uuid;
  confirmation text := nullif(btrim(p_pickup ->> 'confirmation_number'), '');
  starts timestamptz := (p_pickup ->> 'window_start')::timestamptz;
  ends timestamptz := (p_pickup ->> 'window_end')::timestamptz;
  zone text := coalesce(nullif(btrim(p_pickup ->> 'time_zone'), ''), 'America/Los_Angeles');
begin
  perform private.require_cds();
  select * into l from public.shipment_labels where id = p_label for update;
  if not found then
    raise exception 'Label not found' using errcode = 'P0002';
  end if;
  if l.status <> 'active' then
    raise exception 'This label is voided' using errcode = 'P0001';
  end if;
  if l.is_test then
    raise exception 'Pickups can only be booked for real labels' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shipment_pickups p where p.label_id = l.id and p.status = 'scheduled') then
    raise exception 'This label already has a pickup. Cancel it before booking another.' using errcode = 'P0001';
  end if;

  insert into public.shipment_pickups
    (shipment_id, label_id, shipstation_pickup_id, confirmation_number, shipstation_carrier_id, carrier,
     window_start, window_end, time_zone, notes, created_by)
  values
    (l.shipment_id, l.id, p_pickup ->> 'shipstation_pickup_id', left(confirmation, 100), l.shipstation_carrier_id, l.carrier,
     starts, ends, left(zone, 60), left(nullif(btrim(p_pickup ->> 'notes'), ''), 500), auth.uid())
  returning id into new_pickup;

  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status)
  values ('shipstation', 'pickup', l.shipment_id, p_pickup ->> 'shipstation_pickup_id', 'push', 'ok');

  perform private.log_event(l.work_order_id, 'shipping_label', null, null,
    'Carrier pickup booked: ' || l.carrier || ' '
      || to_char(starts at time zone zone, 'Mon DD, YYYY HH24:MI') || ' to ' || to_char(ends at time zone zone, 'HH24:MI')
      || coalesce(', confirmation ' || confirmation, ''),
    false);
  return new_pickup;
end $$;

-- ---------------------------------------------------------------- cancel a pickup (CDS)

-- Marks a pickup cancelled after ShipStation cancelled it.
create function public.cds_cancel_shipment_pickup(p_pickup uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  p public.shipment_pickups;
  wo uuid;
begin
  perform private.require_cds();
  select * into p from public.shipment_pickups where id = p_pickup for update;
  if not found then
    raise exception 'Pickup not found' using errcode = 'P0002';
  end if;
  if p.status <> 'scheduled' then
    raise exception 'This pickup is already cancelled' using errcode = 'P0001';
  end if;

  update public.shipment_pickups
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
   where id = p.id;

  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status)
  values ('shipstation', 'pickup_cancel', p.shipment_id, p.shipstation_pickup_id, 'push', 'ok');

  select s.work_order_id into wo from public.shipments s where s.id = p.shipment_id;
  perform private.log_event(wo, 'shipping_label', null, null,
    'Carrier pickup cancelled' || coalesce(' (confirmation ' || p.confirmation_number || ')', ''),
    false);
end $$;

revoke all on function public.cds_record_shipment_pickup(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cds_record_shipment_pickup(uuid, jsonb) to authenticated;
grant execute on function public.cds_record_shipment_pickup(uuid, jsonb) to service_role;
revoke all on function public.cds_cancel_shipment_pickup(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_cancel_shipment_pickup(uuid) to authenticated;
grant execute on function public.cds_cancel_shipment_pickup(uuid) to service_role;

-- ---------------------------------------------------------------- no void with a pickup

-- The carrier would still come for a voided label: cancel the pickup first.
create function private.label_void_needs_no_pickup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'voided' and old.status = 'active'
     and exists (select 1 from public.shipment_pickups p where p.label_id = new.id and p.status = 'scheduled') then
    raise exception 'This label has a carrier pickup booked. Cancel the pickup before voiding the label.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.label_void_needs_no_pickup() from public;

create trigger void_needs_no_pickup before update of status on public.shipment_labels
  for each row execute function private.label_void_needs_no_pickup();
