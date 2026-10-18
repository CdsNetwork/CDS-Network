-- ShipStation shipping labels and tracking (2026-10-18).
--
-- Who ships what to whom (from the 2026-10-06 call with Clyde, the build brief and the
-- prototype's shipment legs):
--   * Shipping jobs have two legs. CDS creates both labels and reviews the rates first.
--     1. customer_to_affiliate: the fleet location ships the dirty part to the shop. CDS
--        buys the label and sends it to the location ("CDS creates the label, sends it to
--        the customer").
--     2. affiliate_to_customer: the shop ships the cleaned part back on a CDS label ("the
--        affiliate ships it back"). The shop prints that label from its job page.
--   * supplier_to_customer: parts-only orders ship from the parts supplier (an affiliate of
--     kind parts_supplier) straight to the location, on a CDS label.
--   * cds_to_customer and customer_to_cds: CDS's own address (shipping_settings) on one end.
--     Nothing in the history describes a shop shipping to CDS, so there is no such leg.
--   * Pickup jobs (shop drives to the location) have no labels.
--   Addresses come from the structured fields of customer_locations and affiliates; CDS's
--   phone is used when a location or shop has none (carriers require a phone).
--
-- What this adds:
--   1. Carriers and services as data (CDS only). The carrier for a label is a ShipStation
--      carrier id, so UPS by Worldwide Express becomes one more row later. Only active
--      carriers are asked for rates; a carrier with service rows offers only its active
--      services, a carrier without service rows offers all of them.
--   2. shipping_settings (CDS only): CDS's ship-from address and phone, and the default
--      package (45 lb, 24 x 20 x 20 in, the prototype's DPF box).
--   3. shipment_labels: one row per label bought (or test label made). Shops see the labels
--      on their own work orders (tracking, carrier, service, the PDF: they see the ship-to on
--      the label anyway) but never what a label cost. Written only by the cds_ functions.
--   4. shipment_label_costs (CDS only): the rate CDS chose and what the label cost.
--   5. shipstation_webhook_events (CDS only): every verified webhook, once (by body hash).
--      public.shipstation_record_webhook (service role only) applies a tracking update to
--      the shipment status and its tracking events.
--   6. USPS is accepted as a shipment carrier; integration_sync accepts 'shipstation'.

-- ---------------------------------------------------------------- small changes

alter table public.integration_sync drop constraint integration_sync_system_check;
alter table public.integration_sync add constraint integration_sync_system_check
  check (system in ('quickbooks', 'sheets', 'ups', 'fedex', 'email', 'shipstation'));

alter table public.shipments drop constraint shipments_carrier_check;
alter table public.shipments add constraint shipments_carrier_check
  check (carrier in ('UPS', 'FedEx', 'USPS', 'Other'));

-- ---------------------------------------------------------------- carriers and services (CDS only)

create table public.shipping_carriers (
  id uuid primary key default gen_random_uuid(),
  -- The ShipStation carrier id, for example se-7157832 (GET /v2/carriers).
  shipstation_carrier_id text not null unique
    check (shipstation_carrier_id ~ '^se-[0-9]+$' and char_length(shipstation_carrier_id) <= 40),
  carrier text not null check (carrier in ('UPS', 'FedEx', 'USPS', 'Other')),
  name text not null check (btrim(name) <> '' and char_length(name) <= 100),
  active boolean not null default false,
  sort_order int not null default 0,
  notes text check (char_length(notes) <= 1000),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);

create table public.shipping_services (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid not null references public.shipping_carriers on delete cascade,
  service_code text not null check (service_code ~ '^[a-z0-9_]{2,80}$'),
  name text not null check (btrim(name) <> '' and char_length(name) <= 100),
  active boolean not null default true,
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now(),
  unique (carrier_id, service_code)
);

-- One row: CDS's ship-from address and the default package.
create table public.shipping_settings (
  singleton boolean primary key default true check (singleton),
  from_name text check (char_length(from_name) <= 100),
  from_company text check (char_length(from_company) <= 100),
  from_phone text check (char_length(from_phone) <= 30),
  from_email text check (char_length(from_email) <= 200),
  address_line1 text check (char_length(address_line1) <= 200),
  address_line2 text check (char_length(address_line2) <= 200),
  city text check (char_length(city) <= 100),
  region text check (char_length(region) <= 50),
  postal_code text check (char_length(postal_code) <= 20),
  country text not null default 'US' check (country ~ '^[A-Z]{2}$'),
  default_weight_lb numeric(8,2) not null default 45 check (default_weight_lb > 0 and default_weight_lb <= 150),
  default_length_in numeric(6,1) check (default_length_in > 0),
  default_width_in numeric(6,1) check (default_width_in > 0),
  default_height_in numeric(6,1) check (default_height_in > 0),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['shipping_carriers', 'shipping_services', 'shipping_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
    execute format(
      'create policy cds_all on public.%I for all to authenticated using ((select private.is_cds())) with check ((select private.is_cds()))', t);
    execute format('create trigger touch before update on public.%I for each row execute function private.touch_updated_at()', t);
    execute format(
      'create trigger audit after insert or update or delete on public.%I for each row execute function private.audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- labels

create table public.shipment_labels (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments on delete cascade,
  -- Copied from the shipment so the shop policy needs no join.
  work_order_id uuid not null references public.work_orders on delete cascade,
  shipstation_label_id text not null unique check (char_length(shipstation_label_id) <= 60),
  shipstation_shipment_id text check (char_length(shipstation_shipment_id) <= 60),
  shipstation_carrier_id text not null check (char_length(shipstation_carrier_id) <= 40),
  carrier text not null check (carrier in ('UPS', 'FedEx', 'USPS', 'Other')),
  service_code text not null check (char_length(service_code) <= 80),
  service_name text check (char_length(service_name) <= 100),
  tracking_number text check (char_length(tracking_number) <= 100),
  tracking_url text check (char_length(tracking_url) <= 1000),
  -- Made with test_label: no charge, not shippable.
  is_test boolean not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  -- The PDF in the wo-files bucket ('<work_order_id>/labels/<id>.pdf').
  label_file_path text check (char_length(label_file_path) <= 500),
  label_url text check (char_length(label_url) <= 1000),
  ship_from_summary text check (char_length(ship_from_summary) <= 500),
  ship_to_summary text check (char_length(ship_to_summary) <= 500),
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.profiles on delete set null,
  void_message text check (char_length(void_message) <= 1000)
);
-- At most one label in use per shipment leg: void it before buying another.
create unique index shipment_labels_one_active on public.shipment_labels (shipment_id) where status = 'active';
create index shipment_labels_tracking on public.shipment_labels (tracking_number) where status = 'active' and not is_test;
create index on public.shipment_labels (work_order_id);

-- CDS only: the rate CDS picked and what the label cost.
create table public.shipment_label_costs (
  label_id uuid primary key references public.shipment_labels on delete cascade,
  rate_id text check (char_length(rate_id) <= 60),
  quoted_total numeric(12,2) check (quoted_total >= 0),
  label_cost numeric(12,2) not null check (label_cost >= 0),
  insurance_cost numeric(12,2) not null default 0 check (insurance_cost >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  delivery_days int check (delivery_days >= 0),
  estimated_delivery timestamptz
);

-- CDS only: verified webhooks, each delivery once.
create table public.shipstation_webhook_events (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  body_sha256 text not null unique check (body_sha256 ~ '^[0-9a-f]{64}$'),
  resource_type text not null check (char_length(resource_type) <= 60),
  tracking_number text check (char_length(tracking_number) <= 100),
  status_code text check (char_length(status_code) <= 10),
  shipment_id uuid references public.shipments on delete set null,
  outcome text not null check (outcome in ('received', 'applied', 'unknown_tracking', 'ignored')),
  payload jsonb not null
);
create index on public.shipstation_webhook_events (tracking_number);

-- Tracking events are applied once per carrier event.
create index if not exists shipment_tracking_events_shipment_at on public.shipment_tracking_events (shipment_id, occurred_at);

do $$
declare t text;
begin
  foreach t in array array['shipment_labels', 'shipment_label_costs', 'shipstation_webhook_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    -- Written only by the security definer functions below.
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t);
    execute format('create policy cds_read on public.%I for select to authenticated using ((select private.is_cds()))', t);
  end loop;
end $$;

create policy shop_read on public.shipment_labels for select to authenticated
  using (private.shop_can_see_wo(work_order_id));

create trigger audit after insert or update or delete on public.shipment_labels
  for each row execute function private.audit();

-- ---------------------------------------------------------------- record a label (CDS)

-- Records a label the app just made in ShipStation, on its shipment leg, in one step.
-- p_label keys: shipstation_label_id, shipstation_shipment_id, shipstation_carrier_id,
-- service_code, service_name, tracking_number, tracking_url, is_test, label_url,
-- label_file_path, ship_from_summary, ship_to_summary, rate_id, quoted_total, label_cost,
-- insurance_cost, currency, delivery_days, estimated_delivery.
-- A test label never touches the shipment's tracking number or its costs.
create function public.cds_record_shipment_label(p_shipment uuid, p_label jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  sh public.shipments;
  car public.shipping_carriers;
  new_label uuid;
  test boolean := coalesce((p_label ->> 'is_test')::boolean, true);
  tracking text := nullif(btrim(p_label ->> 'tracking_number'), '');
  service text := coalesce(nullif(btrim(p_label ->> 'service_name'), ''), p_label ->> 'service_code');
  total numeric(12,2) := coalesce((p_label ->> 'label_cost')::numeric, 0) + coalesce((p_label ->> 'insurance_cost')::numeric, 0);
begin
  perform private.require_cds();
  select * into sh from public.shipments where id = p_shipment for update;
  if not found then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;
  select * into car from public.shipping_carriers where shipstation_carrier_id = p_label ->> 'shipstation_carrier_id';
  if not found then
    raise exception 'Unknown carrier %', p_label ->> 'shipstation_carrier_id' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shipment_labels l where l.shipment_id = sh.id and l.status = 'active') then
    raise exception 'This shipment already has a label. Void it before creating another.' using errcode = 'P0001';
  end if;

  insert into public.shipment_labels
    (shipment_id, work_order_id, shipstation_label_id, shipstation_shipment_id, shipstation_carrier_id, carrier,
     service_code, service_name, tracking_number, tracking_url, is_test, label_file_path, label_url,
     ship_from_summary, ship_to_summary, created_by)
  values
    (sh.id, sh.work_order_id, p_label ->> 'shipstation_label_id', p_label ->> 'shipstation_shipment_id',
     car.shipstation_carrier_id, car.carrier, p_label ->> 'service_code', left(service, 100), tracking,
     nullif(p_label ->> 'tracking_url', ''), test, nullif(p_label ->> 'label_file_path', ''), nullif(p_label ->> 'label_url', ''),
     left(p_label ->> 'ship_from_summary', 500), left(p_label ->> 'ship_to_summary', 500), auth.uid())
  returning id into new_label;

  insert into public.shipment_label_costs
    (label_id, rate_id, quoted_total, label_cost, insurance_cost, currency, delivery_days, estimated_delivery)
  values
    (new_label, nullif(p_label ->> 'rate_id', ''), (p_label ->> 'quoted_total')::numeric,
     coalesce((p_label ->> 'label_cost')::numeric, 0), coalesce((p_label ->> 'insurance_cost')::numeric, 0),
     coalesce(upper(nullif(p_label ->> 'currency', '')), 'USD'), (p_label ->> 'delivery_days')::int,
     (p_label ->> 'estimated_delivery')::timestamptz);

  update public.shipments
     set carrier = car.carrier,
         service_level = left(service, 100),
         tracking_number = case when test then tracking_number else tracking end,
         label_status = 'ready',
         status = 'label_created',
         label_file_path = nullif(p_label ->> 'label_file_path', ''),
         carrier_shipment_id = p_label ->> 'shipstation_shipment_id',
         eta_text = coalesce(
           case when (p_label ->> 'delivery_days') is not null
                then (p_label ->> 'delivery_days') || ' business day' || case when (p_label ->> 'delivery_days') = '1' then '' else 's' end
           end, eta_text)
   where id = sh.id;

  if not test then
    insert into public.shipment_internal (shipment_id, quoted_cost, actual_cost)
    values (sh.id, (p_label ->> 'quoted_total')::numeric, total)
    on conflict (shipment_id) do update
      set quoted_cost = coalesce(excluded.quoted_cost, public.shipment_internal.quoted_cost),
          actual_cost = excluded.actual_cost;
  end if;

  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status)
  values ('shipstation', 'label', sh.id, p_label ->> 'shipstation_label_id', 'push', case when test then 'test' else 'ok' end);

  perform private.log_event(sh.work_order_id, 'shipping_label', null, null,
    case when test then 'Test shipping label created: ' else 'Shipping label created: ' end
      || car.carrier || ' ' || coalesce(service, '') || coalesce(', tracking ' || tracking, ''),
    true);
  return new_label;
end $$;

-- ---------------------------------------------------------------- void a label (CDS)

-- Marks a label voided after ShipStation approved the void (or for a test label, which
-- ShipStation does not keep). The refund of a real label is pending until the carrier
-- confirms it, so the shipment's actual cost is cleared.
create function public.cds_void_shipment_label(p_label uuid, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  l public.shipment_labels;
begin
  perform private.require_cds();
  perform private.check_length(p_message, 1000);
  select * into l from public.shipment_labels where id = p_label for update;
  if not found then
    raise exception 'Label not found' using errcode = 'P0002';
  end if;
  if l.status <> 'active' then
    raise exception 'This label is already voided' using errcode = 'P0001';
  end if;

  update public.shipment_labels
     set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_message = nullif(btrim(p_message), '')
   where id = l.id;
  update public.shipments
     set label_status = 'voided',
         tracking_number = case when tracking_number is not distinct from l.tracking_number and not l.is_test then null else tracking_number end,
         carrier_shipment_id = null,
         label_file_path = null
   where id = l.shipment_id;
  if not l.is_test then
    update public.shipment_internal set actual_cost = null where shipment_id = l.shipment_id;
  end if;

  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status, error)
  values ('shipstation', 'label_void', l.shipment_id, l.shipstation_label_id, 'push', 'ok', nullif(btrim(p_message), ''));
  perform private.log_event(l.work_order_id, 'shipping_label', null, null,
    case when l.is_test then 'Test shipping label voided' else 'Shipping label voided' end
      || coalesce(' (tracking ' || l.tracking_number || ')', ''),
    true);
end $$;

revoke all on function public.cds_record_shipment_label(uuid, jsonb) from public, anon;
revoke all on function public.cds_void_shipment_label(uuid, text) from public, anon;
grant execute on function public.cds_record_shipment_label(uuid, jsonb) to authenticated;
grant execute on function public.cds_void_shipment_label(uuid, text) to authenticated;

-- ---------------------------------------------------------------- tracking webhook (service role)

-- Applies one verified webhook. Returns 'duplicate' (already received), 'ignored' (not a
-- tracking event), 'unknown_tracking' (no active real label has that tracking number) or
-- 'applied'. Test labels are never tracked. p_events: [{occurred_at, carrier_code,
-- description, location}], only events newer than the newest one stored are added.
create function public.shipstation_record_webhook(
  p_body_sha256 text,
  p_resource_type text,
  p_tracking_number text,
  p_status_code text,
  p_status public.shipment_status,
  p_estimated_delivery timestamptz,
  p_events jsonb,
  p_payload jsonb
) returns text language plpgsql security definer set search_path = '' as $$
declare
  event_id bigint;
  l public.shipment_labels;
  old_status public.shipment_status;
  newest timestamptz;
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

  select s.status into old_status from public.shipments s where s.id = l.shipment_id for update;
  update public.shipments
     set status = coalesce(p_status, status),
         label_status = case when label_status = 'ready' and p_status is not null
                              and p_status not in ('label_created', 'awaiting_pickup') then 'printed' else label_status end,
         eta_text = coalesce(to_char(p_estimated_delivery at time zone 'America/Los_Angeles', 'Mon DD, YYYY'), eta_text)
   where id = l.shipment_id;

  select max(e.occurred_at) into newest from public.shipment_tracking_events e where e.shipment_id = l.shipment_id;
  insert into public.shipment_tracking_events (shipment_id, occurred_at, carrier_code, description, location, raw)
  select l.shipment_id, (e ->> 'occurred_at')::timestamptz, left(e ->> 'carrier_code', 40), left(e ->> 'description', 500),
         left(e ->> 'location', 300), e
    from jsonb_array_elements(case when jsonb_typeof(p_events) = 'array' then p_events else '[]'::jsonb end) e
   where (e ->> 'occurred_at') is not null
     and (newest is null or (e ->> 'occurred_at')::timestamptz > newest)
   order by (e ->> 'occurred_at')::timestamptz;

  update public.shipstation_webhook_events set outcome = 'applied', shipment_id = l.shipment_id where id = event_id;
  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status)
  values ('shipstation', 'tracking', l.shipment_id, l.tracking_number, 'pull', coalesce(p_status::text, 'no_change'));

  if p_status is not null and p_status is distinct from old_status
     and p_status in ('delivered', 'exception', 'address_problem', 'delayed') then
    perform private.log_event(l.work_order_id, 'tracking', null, null,
      'Carrier update (' || l.carrier || ' ' || l.tracking_number || '): ' || replace(p_status::text, '_', ' '),
      true);
  end if;
  return 'applied';
end $$;

revoke all on function public.shipstation_record_webhook(text, text, text, text, public.shipment_status, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.shipstation_record_webhook(text, text, text, text, public.shipment_status, timestamptz, jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------- reference rows

-- CDS's ShipStation carriers (GET /v2/carriers, 2026-10-17). Only CDS's own FedEx account is
-- on; UPS (ShipStation's platform rates) stays off until UPS by Worldwide Express is
-- connected and added as its own row. USPS is the only carrier that accepts test labels
-- (FedEx and UPS refuse test_label), so CDS can turn it on to try the label flow.
insert into public.shipping_carriers (shipstation_carrier_id, carrier, name, active, sort_order, notes) values
  ('se-7157832', 'FedEx', 'FedEx (CDS account)', true, 1, 'CDS''s own FedEx account with contracted rates.'),
  ('se-7157770', 'UPS', 'UPS (ShipStation rates)', false, 2, 'ShipStation platform rates, not CDS''s Worldwide Express rates.'),
  ('se-7157769', 'USPS', 'USPS (ShipStation rates)', false, 3, 'Accepts test labels.'),
  ('se-7157771', 'FedEx', 'FedEx One Balance (ShipStation)', false, 4, 'ShipStation''s walleted FedEx account.');

insert into public.shipping_services (carrier_id, service_code, name)
select c.id, s.code, s.name
  from public.shipping_carriers c
  cross join (values
    ('fedex_ground', 'FedEx Ground'),
    ('fedex_express_saver', 'FedEx Express Saver'),
    ('fedex_2day', 'FedEx 2Day'),
    ('fedex_standard_overnight', 'FedEx Standard Overnight'),
    ('fedex_priority_overnight', 'FedEx Priority Overnight')
  ) as s(code, name)
 where c.shipstation_carrier_id = 'se-7157832';

insert into public.shipping_services (carrier_id, service_code, name)
select c.id, s.code, s.name
  from public.shipping_carriers c
  cross join (values ('usps_ground_advantage', 'USPS Ground Advantage'), ('usps_priority_mail', 'USPS Priority Mail')) as s(code, name)
 where c.shipstation_carrier_id = 'se-7157769';

-- Ship-from address is entered by CDS (Shipping > Settings).
insert into public.shipping_settings (singleton, default_weight_lb, default_length_in, default_width_in, default_height_in)
values (true, 45, 24, 20, 20);
