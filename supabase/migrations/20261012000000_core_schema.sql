-- CDS Network Portal: core schema, milestone 1.
--
-- Access model
--   * Two kinds of login share the Supabase `authenticated` role: CDS staff and shops
--     (affiliates). Column grants cannot tell them apart, so anything a shop must never
--     see (customer prices, fleet prices, margins, tax, internal notes, shipping costs,
--     other shops) lives in a CDS-only table that has no shop policy at all.
--   * Shops read their own work orders (never `pending_review`) and the rows that hang
--     off them. Shops get no insert, update or delete policy anywhere: shop actions go
--     through security definer functions added with the work order flow.
--   * Prices are snapshotted on every work order line when the line is created, so a
--     later catalog or price change never rewrites an existing order.

create extension if not exists citext with schema extensions;

-- Helpers live in a schema PostgREST does not expose.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- enums

create type public.market_code        as enum ('US', 'CA');
create type public.currency_code      as enum ('USD', 'CAD');
create type public.profile_kind       as enum ('cds', 'shop');
create type public.affiliate_kind     as enum ('service_shop', 'parts_supplier', 'cds_owned');
create type public.fulfillment_method as enum ('pickup', 'shipping', 'supplier_direct', 'unspecified');
create type public.request_type       as enum ('service', 'parts_only');
create type public.wo_status          as enum (
  'pending_review', 'awaiting_acceptance', 'accepted', 'picked_up', 'in_process',
  'completed', 'delivered', 'ready_to_invoice', 'invoiced',
  'rejected_by_affiliate', 'cancelled'
);
create type public.shop_ship_status   as enum ('awaiting_delivery', 'received', 'in_process', 'ready_to_ship', 'shipped');
create type public.pickup_window      as enum ('08-10', '10-12', '12-14', '14-16', '16-17', 'coordinate');
create type public.catalog_category   as enum ('service', 'gasket', 'bung', 'clamp', 'part');
create type public.tax_class          as enum ('parts', 'labor', 'shipping', 'exempt');
create type public.component_type     as enum ('DPF', 'DOC', 'SCR', 'EGR');
create type public.component_result   as enum ('cleaned', 'passed', 'failed', 'condemned');
create type public.attachment_category as enum ('condition_damage', 'part_id_tag', 'shipping_damage', 'completed_work', 'other');
create type public.auth_req_kind      as enum ('service', 'part');
create type public.auth_req_status    as enum ('pending', 'approved', 'rejected', 'withdrawn');
create type public.customer_approval  as enum ('not_requested', 'requested', 'approved', 'declined');
create type public.ship_direction     as enum (
  'customer_to_affiliate', 'affiliate_to_customer', 'cds_to_customer', 'customer_to_cds', 'supplier_to_customer'
);
create type public.label_status       as enum ('needed', 'ready', 'sent', 'printed', 'voided', 'error');
create type public.shipment_status    as enum (
  'label_created', 'awaiting_pickup', 'picked_up', 'in_transit', 'out_for_delivery',
  'delivered', 'delayed', 'exception', 'address_problem', 'no_scan'
);
create type public.package_type       as enum ('dpf_box', 'doc_scr_box', 'parts_box', 'custom');
create type public.wo_source          as enum ('manual', 'email_import', 'form_import', 'api');
create type public.price_source       as enum ('fleet', 'customer_override', 'manual');

-- ---------------------------------------------------------------- shared trigger

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- people and organisations

create table public.markets (
  code public.market_code primary key,
  name text not null,
  currency public.currency_code not null
);

create table public.affiliates (
  id uuid primary key default gen_random_uuid(),
  short_code text not null unique,
  display_name text not null,
  kind public.affiliate_kind not null default 'service_shop',
  market public.market_code not null default 'US' references public.markets,
  active boolean not null default true,
  address_line1 text, city text, region text, postal_code text, country text not null default 'US',
  can_egr boolean, can_oil_soaked boolean, can_one_box boolean,
  hours_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- CDS-only facts about a shop (dispatch contacts, tax registration, accounting ids).
create table public.affiliate_internal (
  affiliate_id uuid primary key references public.affiliates on delete cascade,
  tax_type text, tax_registration text, itc_eligible boolean,
  qb_vendor_id text,
  notes text
);

create table public.affiliate_contacts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates on delete cascade,
  email extensions.citext not null,
  label text,
  receives_dispatch boolean not null default true,
  unique (affiliate_id, email)
);

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  email extensions.citext not null unique,
  kind public.profile_kind not null,
  affiliate_id uuid references public.affiliates,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'cds' and affiliate_id is null) or (kind = 'shop' and affiliate_id is not null))
);
-- One login per shop (confirmed by CDS). Drop this index if that changes.
create unique index profiles_one_login_per_shop on public.profiles (affiliate_id) where kind = 'shop' and active;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  default_market public.market_code not null default 'US' references public.markets,
  active boolean not null default true
);

create table public.customer_billing (
  customer_id uuid primary key references public.customers on delete cascade,
  billing_email extensions.citext,
  tax_exempt boolean not null default false,
  qb_customer_id text
);

create table public.customer_locations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers,
  code text not null,
  location_number text,
  name text not null,
  market public.market_code not null default 'US' references public.markets,
  address_raw text not null,
  address_line1 text, city text, region text, postal_code text, country text not null default 'US',
  default_affiliate_id uuid references public.affiliates,
  fulfillment public.fulfillment_method not null default 'unspecified',
  dock_note text,
  routing_notes text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (customer_id, code)
);
create index on public.customer_locations (customer_id, location_number);

-- ---------------------------------------------------------------- catalog and pricing

-- Shop-visible: names, SKUs, OE cross reference. No money here.
create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  category public.catalog_category not null,
  name text not null,
  oe_cross text,
  tax_class public.tax_class not null,
  shop_selectable boolean not null default true,
  active boolean not null default true
);

-- What CDS pays the shop. Parts: the "network" figure; services: the "affiliate" figure.
-- affiliate_id null = rate for every shop; a row with affiliate_id = per-shop rate.
-- Shops see the default rows and their own rows only.
create table public.shop_rates (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references public.catalog_items on delete cascade,
  market public.market_code not null default 'US' references public.markets,
  affiliate_id uuid references public.affiliates on delete cascade,
  amount numeric(12,2) check (amount >= 0),
  effective_from date not null default current_date,
  effective_to date,
  check (effective_to is null or effective_to > effective_from)
);
create unique index shop_rates_uq on public.shop_rates
  (catalog_item_id, market, coalesce(affiliate_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);

-- CDS-only: default price CDS charges a fleet ("fleet" figure).
create table public.sell_prices (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references public.catalog_items on delete cascade,
  market public.market_code not null default 'US' references public.markets,
  amount numeric(12,2) not null check (amount >= 0),
  effective_from date not null default current_date,
  effective_to date,
  unique (catalog_item_id, market, effective_from),
  check (effective_to is null or effective_to > effective_from)
);

-- CDS-only: a customer's own price for an item.
create table public.customer_price_overrides (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers on delete cascade,
  catalog_item_id uuid not null references public.catalog_items on delete cascade,
  market public.market_code not null default 'US' references public.markets,
  amount numeric(12,2) not null check (amount >= 0),
  effective_from date not null default current_date,
  effective_to date,
  note text,
  unique (customer_id, catalog_item_id, market, effective_from),
  check (effective_to is null or effective_to > effective_from)
);

create table public.tax_rates (
  id uuid primary key default gen_random_uuid(),
  market public.market_code not null references public.markets,
  region text not null,
  postal_code text,
  rate numeric(6,3) not null,
  gst numeric(6,3), pst numeric(6,3), hst numeric(6,3),
  taxes_parts boolean not null, taxes_labor boolean not null, taxes_shipping boolean not null,
  label text,
  unique nulls not distinct (market, region, postal_code)
);

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles
);

-- ---------------------------------------------------------------- work orders

create sequence public.wo_number_seq start 30000;

-- Shop-visible columns only.
create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  wo_number bigint not null unique default nextval('public.wo_number_seq'),
  market public.market_code not null default 'US' references public.markets,
  currency public.currency_code not null default 'USD',
  customer_id uuid not null references public.customers,
  location_id uuid references public.customer_locations,
  location_label text not null,
  site_address text,
  request_type public.request_type not null default 'service',
  fulfillment public.fulfillment_method not null default 'unspecified',
  affiliate_id uuid references public.affiliates,
  status public.wo_status not null default 'pending_review',
  unit_number text not null,
  po_number text,
  requested_work text not null,
  pickup_window public.pickup_window,
  shop_ship_status public.shop_ship_status,
  affiliate_invoice_ref text,
  dispatched_at timestamptz, accepted_at timestamptz, picked_up_at timestamptz,
  completed_at timestamptz, delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('pending_review', 'cancelled') or affiliate_id is not null),
  check (fulfillment <> 'pickup'
         or status in ('pending_review', 'awaiting_acceptance', 'cancelled', 'rejected_by_affiliate')
         or pickup_window is not null),
  check (status not in ('completed', 'delivered', 'ready_to_invoice', 'invoiced')
         or coalesce(btrim(affiliate_invoice_ref), '') <> '')
);
create index on public.work_orders (affiliate_id, status);
create index on public.work_orders (customer_id, created_at);

-- CDS-only, 1:1 with work_orders.
create table public.work_order_internal (
  work_order_id uuid primary key references public.work_orders on delete cascade,
  source public.wo_source not null default 'manual',
  location_code_raw text,
  review_reason text,
  routing_notes text,
  internal_notes text,
  approved_by uuid references public.profiles,
  approved_at timestamptz,
  auto_dispatched boolean not null default false,
  egr_capable_snapshot boolean, oil_soaked_capable_snapshot boolean,
  supplier_cost_tbd boolean not null default false,
  tax_rate numeric(6,3) not null default 0,
  tax_parts boolean not null default true,
  tax_labor boolean not null default false,
  tax_shipping boolean not null default true,
  tax_jurisdiction text,
  tax_source text,
  ready_to_invoice_at timestamptz,
  qb_invoice_id text unique,
  qb_invoice_number text unique,
  invoice_email_status text,
  invoiced_at timestamptz,
  qb_bill_id text
);

create table public.authorization_requests (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders on delete cascade,
  seq int not null,
  kind public.auth_req_kind not null,
  catalog_item_id uuid not null references public.catalog_items,
  qty numeric(10,2) not null default 1 check (qty > 0),
  note text not null check (btrim(note) <> ''),
  status public.auth_req_status not null default 'pending',
  requested_by uuid references public.profiles,
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles,
  decided_at timestamptz,
  customer_approval public.customer_approval not null default 'not_requested',
  customer_approval_at timestamptz,
  unique (work_order_id, seq),
  check (status <> 'approved' or customer_approval = 'approved')
);

-- CDS-only, 1:1 with a request: decision notes and who at the customer approved.
-- Shops see only the request status (CDS confirmed 2026-10-14: no notes beyond what is required).
create table public.authorization_decisions (
  request_id uuid primary key references public.authorization_requests on delete cascade,
  decision_note text,
  customer_approved_by_name text,
  customer_approval_recorded_by uuid references public.profiles
);

-- Shop-visible. shop_unit_rate is the shop's pay, snapshotted on insert.
create table public.work_order_lines (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders on delete cascade,
  catalog_item_id uuid not null references public.catalog_items,
  qty numeric(10,2) not null check (qty > 0),
  shop_unit_rate numeric(12,2),
  origin text not null default 'cds_order' check (origin in ('cds_order', 'shop_added', 'auth_request')),
  auth_request_id uuid references public.authorization_requests,
  added_by uuid references public.profiles,
  created_at timestamptz not null default now()
);
create index on public.work_order_lines (work_order_id);

-- CDS-only, 1:1 with a line: what the customer pays for it.
create table public.work_order_line_pricing (
  line_id uuid primary key references public.work_order_lines on delete cascade,
  work_order_id uuid not null references public.work_orders on delete cascade,
  customer_unit_price numeric(12,2) not null,
  price_source public.price_source not null,
  tax_class public.tax_class not null
);
create index on public.work_order_line_pricing (work_order_id);

create table public.work_order_components (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders on delete cascade,
  seq int not null,
  component_type public.component_type not null,
  manufacturer text, part_number text, serial_number text,
  dp_before numeric(6,2), dp_after numeric(6,2),
  weight_before_g numeric(10,1), weight_after_g numeric(10,1),
  weight_removed_g numeric(10,1) generated always as (weight_before_g - weight_after_g) stored,
  result public.component_result,
  result_note text,
  updated_by uuid references public.profiles,
  updated_at timestamptz not null default now(),
  unique (work_order_id, seq),
  -- EGR coolers are Pass/Fail only, no measurements.
  check (component_type <> 'EGR' or (
    dp_before is null and dp_after is null and weight_before_g is null and weight_after_g is null
    and (result is null or result in ('passed', 'failed')))),
  check (component_type = 'EGR' or result is null or result in ('cleaned', 'failed', 'condemned')),
  check (result is null or result not in ('failed', 'condemned') or coalesce(btrim(result_note), '') <> ''),
  check (weight_before_g is null or weight_before_g > 0),
  check (weight_after_g is null or weight_after_g > 0),
  check (dp_before is null or dp_before >= 0),
  check (dp_after is null or dp_after >= 0)
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders on delete cascade,
  component_id uuid references public.work_order_components on delete set null,
  category public.attachment_category not null,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  note text,
  shop_visible boolean not null default true,
  uploaded_by uuid references public.profiles,
  uploaded_at timestamptz not null default now()
);

create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders on delete cascade,
  direction public.ship_direction not null,
  carrier text check (carrier in ('UPS', 'FedEx', 'Other')),
  service_level text,
  tracking_number text,
  label_status public.label_status not null default 'needed',
  status public.shipment_status not null default 'label_created',
  package_type public.package_type,
  weight_lb numeric(8,2), length_in numeric(6,1), width_in numeric(6,1), height_in numeric(6,1),
  ship_from text, ship_to text,
  eta_text text,
  label_file_path text,
  carrier_shipment_id text,
  auto_created boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (carrier, tracking_number)
);

-- CDS-only, 1:1 with a shipment: costs and internal notes.
create table public.shipment_internal (
  shipment_id uuid primary key references public.shipments on delete cascade,
  notes text,
  quoted_cost numeric(12,2),
  actual_cost numeric(12,2),
  currency public.currency_code not null default 'USD'
);

create table public.work_order_events (
  id bigint generated always as identity primary key,
  work_order_id uuid not null references public.work_orders on delete cascade,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles,
  event_type text not null,
  from_status public.wo_status,
  to_status public.wo_status,
  message text not null,
  shop_visible boolean not null default false
);
create index on public.work_order_events (work_order_id, at);

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles,
  table_name text not null,
  row_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  old_data jsonb,
  new_data jsonb
);

-- Milestone 2 placeholders.
create table public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null,
  provider_message_id text not null unique,
  received_at timestamptz not null,
  from_address extensions.citext,
  subject text,
  raw_storage_path text,
  parser text,
  parsed jsonb,
  status text not null default 'new'
    check (status in ('new', 'parsed', 'needs_review', 'created_wo', 'ignored', 'error')),
  error text,
  work_order_id uuid references public.work_orders
);
alter table public.work_order_internal
  add column inbound_email_id uuid references public.inbound_emails;

create table public.shipment_tracking_events (
  id bigint generated always as identity primary key,
  shipment_id uuid not null references public.shipments on delete cascade,
  occurred_at timestamptz,
  carrier_code text,
  description text,
  location text,
  raw jsonb
);

create table public.integration_sync (
  id bigint generated always as identity primary key,
  system text not null check (system in ('quickbooks', 'sheets', 'ups', 'fedex', 'email')),
  entity text not null,
  entity_id uuid,
  external_id text,
  direction text check (direction in ('push', 'pull')),
  status text not null,
  error text,
  at timestamptz not null default now()
);

-- updated_at triggers
create trigger touch before update on public.affiliates for each row execute function private.touch_updated_at();
create trigger touch before update on public.profiles for each row execute function private.touch_updated_at();
create trigger touch before update on public.customer_locations for each row execute function private.touch_updated_at();
create trigger touch before update on public.app_settings for each row execute function private.touch_updated_at();
create trigger touch before update on public.work_orders for each row execute function private.touch_updated_at();
create trigger touch before update on public.work_order_components for each row execute function private.touch_updated_at();
create trigger touch before update on public.shipments for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------- identity helpers

create function private.is_cds() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.kind = 'cds' from public.profiles p where p.id = auth.uid() and p.active),
    false)
$$;

create function private.my_affiliate() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.affiliate_id from public.profiles p
  join public.affiliates a on a.id = p.affiliate_id and a.active
  where p.id = auth.uid() and p.kind = 'shop' and p.active
$$;

-- True when the work order belongs to the caller's shop and has been released to it.
create function private.shop_can_see_wo(wo uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.work_orders w
    where w.id = wo
      and w.affiliate_id = private.my_affiliate()
      and w.status not in ('pending_review', 'rejected_by_affiliate'))
$$;

revoke all on function private.is_cds(), private.my_affiliate(), private.shop_can_see_wo(uuid) from public;
grant execute on function private.is_cds(), private.my_affiliate(), private.shop_can_see_wo(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------- price snapshots

-- The rate a shop is paid for an item on a date: its own rate first, else the default.
create function private.shop_rate_for(item uuid, shop uuid, mkt public.market_code, on_date date)
returns numeric language sql stable security definer set search_path = '' as $$
  select r.amount from public.shop_rates r
  where r.catalog_item_id = item and r.market = mkt
    and (r.affiliate_id = shop or r.affiliate_id is null)
    and r.effective_from <= on_date and (r.effective_to is null or r.effective_to > on_date)
  order by (r.affiliate_id is null), r.effective_from desc
  limit 1
$$;

create function private.snapshot_shop_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
begin
  select w.affiliate_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  if new.shop_unit_rate is null or not private.is_cds() then
    new.shop_unit_rate := private.shop_rate_for(new.catalog_item_id, wo.affiliate_id, wo.market, current_date);
  end if;
  if new.added_by is null then
    new.added_by := auth.uid();
  end if;
  return new;
end $$;

revoke all on function private.shop_rate_for(uuid, uuid, public.market_code, date) from public;

-- Customer price: the customer's override if one is in effect, else the fleet price.
create function private.write_line_pricing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  item_class public.tax_class;
  price numeric(12,2);
  src public.price_source := 'customer_override';
begin
  select w.customer_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  select c.tax_class into item_class from public.catalog_items c where c.id = new.catalog_item_id;

  select o.amount into price from public.customer_price_overrides o
  where o.customer_id = wo.customer_id and o.catalog_item_id = new.catalog_item_id and o.market = wo.market
    and o.effective_from <= current_date and (o.effective_to is null or o.effective_to > current_date)
  order by o.effective_from desc limit 1;

  if price is null then
    src := 'fleet';
    select s.amount into price from public.sell_prices s
    where s.catalog_item_id = new.catalog_item_id and s.market = wo.market
      and s.effective_from <= current_date and (s.effective_to is null or s.effective_to > current_date)
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

create trigger snapshot_prices before insert on public.work_order_lines
  for each row execute function private.snapshot_shop_rate();
create trigger write_pricing after insert on public.work_order_lines
  for each row execute function private.write_line_pricing();

-- Snapshots are fixed once taken.
create function private.freeze_line_prices() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.shop_unit_rate is distinct from old.shop_unit_rate
      and coalesce(current_setting('cds.resnapshot', true), '') <> 'on')
     or new.catalog_item_id is distinct from old.catalog_item_id
     or new.work_order_id is distinct from old.work_order_id then
    raise exception 'Line item and snapshotted rate cannot change; remove the line and add a new one'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger freeze_prices before update on public.work_order_lines
  for each row execute function private.freeze_line_prices();

-- A work order moved to another shop (or dispatched for the first time) pays that
-- shop's rate. Re-snapshot its lines so no shop ever sees another shop's own rate.
create function private.resnapshot_on_reassign() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('cds.resnapshot', 'on', true);
  update public.work_order_lines l
     set shop_unit_rate = private.shop_rate_for(l.catalog_item_id, new.affiliate_id, new.market, current_date)
   where l.work_order_id = new.id;
  perform set_config('cds.resnapshot', '', true);
  return null;
end $$;
create trigger resnapshot_on_reassign after update of affiliate_id on public.work_orders
  for each row when (new.affiliate_id is distinct from old.affiliate_id)
  execute function private.resnapshot_on_reassign();

-- ---------------------------------------------------------------- financials (CDS only)

-- security_invoker: the caller's RLS applies to every table read here, and the base
-- table (work_order_internal) is CDS-only, so a shop gets zero rows.
create view public.work_order_financials with (security_invoker = true) as
select
  w.id as work_order_id,
  w.wo_number,
  coalesce(l.customer_subtotal, 0)::numeric(12,2) as customer_subtotal,
  coalesce(l.shop_subtotal, 0)::numeric(12,2) as shop_subtotal,
  coalesce(s.shipping_cost, 0)::numeric(12,2) as shipping_cost,
  (coalesce(l.customer_subtotal, 0) - coalesce(l.shop_subtotal, 0))::numeric(12,2) as margin_before_shipping,
  (coalesce(l.customer_subtotal, 0) - coalesce(l.shop_subtotal, 0) - coalesce(s.shipping_cost, 0))::numeric(12,2) as margin,
  i.supplier_cost_tbd
from public.work_order_internal i
join public.work_orders w on w.id = i.work_order_id
left join lateral (
  select sum(p.customer_unit_price * ln.qty) as customer_subtotal,
         sum(coalesce(ln.shop_unit_rate, 0) * ln.qty) as shop_subtotal
  from public.work_order_lines ln
  join public.work_order_line_pricing p on p.line_id = ln.id
  where ln.work_order_id = w.id
) l on true
left join lateral (
  select sum(coalesce(c.actual_cost, c.quoted_cost, 0)) as shipping_cost
  from public.shipments sh
  join public.shipment_internal c on c.shipment_id = sh.id
  where sh.work_order_id = w.id
) s on true
where (select private.is_cds());

-- ---------------------------------------------------------------- row level security

do $$
declare t text;
begin
  foreach t in array array[
    'markets', 'affiliates', 'affiliate_internal', 'affiliate_contacts', 'profiles',
    'customers', 'customer_billing', 'customer_locations',
    'catalog_items', 'shop_rates', 'sell_prices', 'customer_price_overrides', 'tax_rates', 'app_settings',
    'work_orders', 'work_order_internal', 'authorization_requests', 'work_order_lines',
    'work_order_line_pricing', 'work_order_components', 'attachments', 'shipments', 'shipment_internal', 'authorization_decisions',
    'work_order_events', 'audit_log', 'inbound_emails', 'shipment_tracking_events', 'integration_sync'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- No anonymous access to anything.
    execute format('revoke all on public.%I from anon', t);
    -- CDS staff: full access.
    execute format(
      'create policy cds_all on public.%I for all to authenticated using ((select private.is_cds())) with check ((select private.is_cds()))', t);
  end loop;
end $$;

revoke all on public.work_order_financials from anon;
revoke insert, update, delete, truncate, references, trigger on public.work_order_financials from authenticated;

-- Writes stay behind RLS for authenticated; TRUNCATE ignores RLS, so nobody gets it.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t.tablename);
  end loop;
end $$;

-- Future tables and functions: nothing for anon by default.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

-- The app uses the REST API only. GraphQL would expose the schema to any login.
drop extension if exists pg_graphql;
revoke all on sequence public.wo_number_seq from anon;

-- Shop read policies. Every table not listed here is CDS-only.
create policy shop_read on public.markets for select to authenticated
  using ((select private.my_affiliate()) is not null);

create policy shop_read on public.affiliates for select to authenticated
  using (id = (select private.my_affiliate()));

create policy shop_read on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy shop_read on public.catalog_items for select to authenticated
  using ((select private.my_affiliate()) is not null and active);

create policy shop_read on public.shop_rates for select to authenticated
  using ((select private.my_affiliate()) is not null
         and (affiliate_id is null or affiliate_id = (select private.my_affiliate())));

create policy shop_read on public.work_orders for select to authenticated
  using (affiliate_id = (select private.my_affiliate()) and status not in ('pending_review', 'rejected_by_affiliate'));

-- Customer name only, and only for customers on the shop's own work orders.
create policy shop_read on public.customers for select to authenticated
  using (exists (
    select 1 from public.work_orders w
    where w.customer_id = customers.id
      and w.affiliate_id = (select private.my_affiliate())
      and w.status not in ('pending_review', 'rejected_by_affiliate')));

create policy shop_read on public.work_order_lines for select to authenticated
  using (private.shop_can_see_wo(work_order_id));
create policy shop_read on public.work_order_components for select to authenticated
  using (private.shop_can_see_wo(work_order_id));
create policy shop_read on public.authorization_requests for select to authenticated
  using (private.shop_can_see_wo(work_order_id));
create policy shop_read on public.shipments for select to authenticated
  using (private.shop_can_see_wo(work_order_id));
create policy shop_read on public.attachments for select to authenticated
  using (shop_visible and private.shop_can_see_wo(work_order_id));
create policy shop_read on public.work_order_events for select to authenticated
  using (shop_visible and private.shop_can_see_wo(work_order_id));

-- ---------------------------------------------------------------- storage

-- Private bucket for work order files. Object paths are '<work_order_id>/<file>'.
-- Idempotent. On hosted Supabase the storage tables exist before migrations run; on a
-- local stack the storage service creates them later, so scripts/test-db.sh calls this
-- again once the stack is up.
create function private.ensure_storage() returns void
language plpgsql set search_path = '' as $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'storage schema not ready; run select private.ensure_storage() later';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values ('wo-files', 'wo-files', false, 26214400)
  on conflict (id) do nothing;

  drop policy if exists wo_files_cds on storage.objects;
  create policy wo_files_cds on storage.objects for all to authenticated
    using (bucket_id = 'wo-files' and (select private.is_cds()))
    with check (bucket_id = 'wo-files' and (select private.is_cds()));

  drop policy if exists wo_files_shop_read on storage.objects;
  create policy wo_files_shop_read on storage.objects for select to authenticated
    using (
      bucket_id = 'wo-files'
      and exists (
        select 1 from public.attachments a
        where a.storage_path = storage.objects.name
          and storage.objects.name like a.work_order_id::text || '/%'
          and a.shop_visible
          and private.shop_can_see_wo(a.work_order_id)));
end $$;
revoke all on function private.ensure_storage() from public;

select private.ensure_storage();

-- ---------------------------------------------------------------- reference rows

insert into public.markets (code, name, currency) values
  ('US', 'United States', 'USD'),
  ('CA', 'Canada', 'CAD');

insert into public.app_settings (key, value) values
  ('auto_dispatch_enabled', 'false'::jsonb);
