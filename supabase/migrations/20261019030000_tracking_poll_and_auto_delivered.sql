-- Tracking by polling, and Delivered set automatically from carrier tracking (2026-10-19).
--
-- CDS decisions (Ashley, 2026-10-19):
--   * The ShipStation tracking webhook is NOT registered (an existing webhook on the account
--     must stay). The portal polls GET /v2/labels/{label_id}/track every 2 hours instead, for
--     active real labels whose leg is not delivered yet (about 300 labels a month). The
--     webhook route and its function stay, unregistered.
--   * When the leg back to the customer is delivered, the work order moves to Delivered on
--     its own, with the carrier's delivery date and time. Inbound legs (to the shop) never
--     move the order. A cancelled, invoiced or already delivered order is never moved.
--
-- What this adds:
--   1. shipments.delivered_at: when the carrier delivered the leg (shown in Pacific time).
--   2. shipment_label_tracking (CDS only, not audited): when each label was last polled and
--      the last error, so each run polls the least recently checked labels first.
--   3. private.apply_tracking: the one place a tracking result (webhook or poll) changes a
--      leg: status, label status, ETA, delivered time, new carrier events, the carrier
--      update event, and the automatic Delivered step. It writes only when something changed.
--   4. private.auto_deliver: moves a completed work order to Delivered when every return leg
--      that has a label is delivered, as the system (no actor), with an event "Delivered per
--      carrier tracking <Pacific date time> PT". Same rule as cds_set_status (only from
--      completed: the shop's invoice reference is required for Delivered).
--   5. Service role functions for the poll: shipstation_labels_to_track,
--      shipstation_record_tracking and shipstation_auto_deliver_sweep (moves orders whose
--      return leg was delivered before the shop marked them completed).
--   6. shipstation_record_webhook takes the actual delivery date separately and uses
--      private.apply_tracking.

-- ---------------------------------------------------------------- delivered time per leg

alter table public.shipments add column delivered_at timestamptz;

update public.shipments s
   set delivered_at = coalesce(
         (select max(e.occurred_at) from public.shipment_tracking_events e where e.shipment_id = s.id),
         s.updated_at)
 where s.status = 'delivered' and s.delivered_at is null;

-- ---------------------------------------------------------------- poll state (CDS only)

create table public.shipment_label_tracking (
  label_id uuid primary key references public.shipment_labels on delete cascade,
  checked_at timestamptz not null default now(),
  status_code text check (char_length(status_code) <= 10),
  error text check (char_length(error) <= 1000)
);
alter table public.shipment_label_tracking enable row level security;
revoke all on public.shipment_label_tracking from anon;
revoke insert, update, delete, truncate, references, trigger on public.shipment_label_tracking from authenticated;
create policy cds_read on public.shipment_label_tracking for select to authenticated using ((select private.is_cds()));

-- ---------------------------------------------------------------- automatic Delivered

-- Legs that end at the customer's location.
create function private.is_return_leg(d public.ship_direction) returns boolean
language sql immutable set search_path = '' as $$
  select d in ('affiliate_to_customer', 'cds_to_customer', 'supplier_to_customer')
$$;

-- Moves one work order to Delivered when it is completed and every return leg that has a
-- label (or tracking) is delivered. Returns true when it moved the order.
create function private.auto_deliver(p_work_order uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  at_time timestamptz;
begin
  select * into wo from public.work_orders where id = p_work_order for update;
  if not found or wo.status <> 'completed' then
    return false;
  end if;
  if exists (
    select 1 from public.shipments s
     where s.work_order_id = wo.id and private.is_return_leg(s.direction)
       and s.status not in ('delivered', 'label_needed')
  ) then
    return false;
  end if;
  select max(coalesce(s.delivered_at, s.updated_at)) into at_time
    from public.shipments s
   where s.work_order_id = wo.id and private.is_return_leg(s.direction) and s.status = 'delivered';
  if at_time is null then
    return false;
  end if;

  update public.work_orders set status = 'delivered', delivered_at = at_time where id = wo.id;
  insert into public.work_order_events (work_order_id, actor_id, event_type, from_status, to_status, message, shop_visible)
  values (wo.id, null, 'status_change', wo.status, 'delivered',
          'Delivered per carrier tracking ' || to_char(at_time at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') || ' PT',
          true);
  return true;
end $$;

-- ---------------------------------------------------------------- apply one tracking result

-- Returns true when the leg or its events changed. Never called for test labels.
create function private.apply_tracking(
  l public.shipment_labels,
  p_status public.shipment_status,
  p_estimated_delivery timestamptz,
  p_actual_delivery timestamptz,
  p_events jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  sh public.shipments;
  new_label_status public.label_status;
  new_eta text;
  new_delivered timestamptz;
  newest timestamptz;
  added int;
  changed boolean;
begin
  select * into sh from public.shipments s where s.id = l.shipment_id for update;
  if not found then
    return false;
  end if;

  new_label_status := case when sh.label_status = 'ready' and p_status is not null
                             and p_status not in ('label_created', 'awaiting_pickup') then 'printed' else sh.label_status end;
  new_eta := coalesce(to_char(coalesce(p_actual_delivery, p_estimated_delivery) at time zone 'America/Los_Angeles', 'Mon DD, YYYY'), sh.eta_text);
  new_delivered := case when coalesce(p_status, sh.status) = 'delivered'
                        then coalesce(p_actual_delivery, sh.delivered_at, now()) end;
  changed := coalesce(p_status, sh.status) is distinct from sh.status
          or new_label_status is distinct from sh.label_status
          or new_eta is distinct from sh.eta_text
          or new_delivered is distinct from sh.delivered_at;
  if changed then
    update public.shipments
       set status = coalesce(p_status, status),
           label_status = new_label_status,
           eta_text = new_eta,
           delivered_at = new_delivered
     where id = sh.id;
  end if;

  select max(e.occurred_at) into newest from public.shipment_tracking_events e where e.shipment_id = sh.id;
  insert into public.shipment_tracking_events (shipment_id, occurred_at, carrier_code, description, location, raw)
  select sh.id, (e ->> 'occurred_at')::timestamptz, left(e ->> 'carrier_code', 40), left(e ->> 'description', 500),
         left(e ->> 'location', 300), e
    from jsonb_array_elements(case when jsonb_typeof(p_events) = 'array' then p_events else '[]'::jsonb end) e
   where (e ->> 'occurred_at') is not null
     and (newest is null or (e ->> 'occurred_at')::timestamptz > newest)
   order by (e ->> 'occurred_at')::timestamptz;
  get diagnostics added = row_count;

  if p_status is not null and p_status is distinct from sh.status
     and p_status in ('delivered', 'exception', 'address_problem', 'delayed') then
    perform private.log_event(l.work_order_id, 'tracking', null, null,
      'Carrier update (' || l.carrier || ' ' || l.tracking_number || '): ' || replace(p_status::text, '_', ' '),
      true);
  end if;

  if p_status = 'delivered' and private.is_return_leg(sh.direction) then
    perform private.auto_deliver(l.work_order_id);
  end if;
  return changed or added > 0;
end $$;

-- ---------------------------------------------------------------- poll (service role)

-- Active real labels with a tracking number whose leg is not delivered, made in the last
-- 60 days, least recently checked first.
create function public.shipstation_labels_to_track(p_limit int default 100)
returns table (label_id uuid, shipstation_label_id text, tracking_number text, carrier text)
language sql stable security definer set search_path = '' as $$
  select l.id, l.shipstation_label_id, l.tracking_number, l.carrier
    from public.shipment_labels l
    join public.shipments s on s.id = l.shipment_id
    left join public.shipment_label_tracking t on t.label_id = l.id
   where l.status = 'active' and not l.is_test and l.tracking_number is not null
     and s.status <> 'delivered'
     and l.created_at > now() - interval '60 days'
   order by t.checked_at nulls first, l.created_at
   limit greatest(1, least(coalesce(p_limit, 100), 1000))
$$;

-- Records one poll result for a label. Returns 'error' (p_error set: only the poll state is
-- stored), 'skipped' (no such active real label), 'applied' or 'unchanged'.
create function public.shipstation_record_tracking(
  p_label uuid,
  p_status_code text,
  p_status public.shipment_status,
  p_estimated_delivery timestamptz,
  p_actual_delivery timestamptz,
  p_events jsonb,
  p_error text default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  l public.shipment_labels;
  changed boolean;
begin
  select * into l from public.shipment_labels where id = p_label and status = 'active' and not is_test;
  if not found then
    return 'skipped';
  end if;

  insert into public.shipment_label_tracking (label_id, checked_at, status_code, error)
  values (l.id, now(), left(p_status_code, 10), left(nullif(btrim(p_error), ''), 1000))
  on conflict (label_id) do update
    set checked_at = excluded.checked_at,
        status_code = coalesce(excluded.status_code, public.shipment_label_tracking.status_code),
        error = excluded.error;
  if nullif(btrim(p_error), '') is not null then
    return 'error';
  end if;

  changed := private.apply_tracking(l, p_status, p_estimated_delivery, p_actual_delivery, p_events);
  if changed then
    insert into public.integration_sync (system, entity, entity_id, external_id, direction, status)
    values ('shipstation', 'tracking', l.shipment_id, l.tracking_number, 'pull', coalesce(p_status::text, 'no_change'));
  end if;
  return case when changed then 'applied' else 'unchanged' end;
end $$;

-- Moves completed work orders whose return legs were already delivered (the shop marked the
-- order completed after the carrier delivered). Returns how many it moved.
create function public.shipstation_auto_deliver_sweep() returns int
language plpgsql security definer set search_path = '' as $$
declare
  w uuid;
  moved int := 0;
begin
  for w in
    select distinct s.work_order_id
      from public.shipments s
      join public.work_orders o on o.id = s.work_order_id
     where o.status = 'completed' and s.status = 'delivered' and private.is_return_leg(s.direction)
  loop
    if private.auto_deliver(w) then
      moved := moved + 1;
    end if;
  end loop;
  return moved;
end $$;

-- ---------------------------------------------------------------- webhook (unregistered, kept)

drop function public.shipstation_record_webhook(text, text, text, text, public.shipment_status, timestamptz, jsonb, jsonb);

create function public.shipstation_record_webhook(
  p_body_sha256 text,
  p_resource_type text,
  p_tracking_number text,
  p_status_code text,
  p_status public.shipment_status,
  p_estimated_delivery timestamptz,
  p_events jsonb,
  p_payload jsonb,
  p_actual_delivery timestamptz default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  event_id bigint;
  l public.shipment_labels;
begin
  insert into public.shipstation_webhook_events (body_sha256, resource_type, tracking_number, status_code, outcome, payload)
  values (p_body_sha256, left(coalesce(p_resource_type, 'unknown'), 60), left(p_tracking_number, 100), left(p_status_code, 10),
          'received', coalesce(p_payload, '{}'::jsonb))
  on conflict (body_sha256) do nothing
  returning id into event_id;
  if event_id is null then
    return 'duplicate';
  end if;

  if p_resource_type is distinct from 'API_TRACK' or coalesce(btrim(p_tracking_number), '') = '' then
    update public.shipstation_webhook_events set outcome = 'ignored' where id = event_id;
    return 'ignored';
  end if;

  select * into l from public.shipment_labels
   where tracking_number = btrim(p_tracking_number) and status = 'active' and not is_test
   order by created_at desc limit 1;
  if not found then
    update public.shipstation_webhook_events set outcome = 'unknown_tracking' where id = event_id;
    return 'unknown_tracking';
  end if;

  perform private.apply_tracking(l, p_status, p_estimated_delivery, p_actual_delivery, p_events);

  update public.shipstation_webhook_events set outcome = 'applied', shipment_id = l.shipment_id where id = event_id;
  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status)
  values ('shipstation', 'tracking', l.shipment_id, l.tracking_number, 'pull', coalesce(p_status::text, 'no_change'));
  return 'applied';
end $$;

-- ---------------------------------------------------------------- grants

revoke all on function private.is_return_leg(public.ship_direction) from public;
revoke all on function private.auto_deliver(uuid) from public;
revoke all on function private.apply_tracking(public.shipment_labels, public.shipment_status, timestamptz, timestamptz, jsonb) from public;

revoke all on function public.shipstation_labels_to_track(int) from public, anon, authenticated;
revoke all on function public.shipstation_record_tracking(uuid, text, public.shipment_status, timestamptz, timestamptz, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.shipstation_auto_deliver_sweep() from public, anon, authenticated;
revoke all on function public.shipstation_record_webhook(text, text, text, text, public.shipment_status, timestamptz, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;

grant execute on function public.shipstation_labels_to_track(int) to service_role;
grant execute on function public.shipstation_record_tracking(uuid, text, public.shipment_status, timestamptz, timestamptz, jsonb, text) to service_role;
grant execute on function public.shipstation_auto_deliver_sweep() to service_role;
grant execute on function public.shipstation_record_webhook(text, text, text, text, public.shipment_status, timestamptz, jsonb, jsonb, timestamptz)
  to service_role;
