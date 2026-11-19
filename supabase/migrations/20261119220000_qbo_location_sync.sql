-- QuickBooks customers (sites) become portal locations (2026-11-19, agreed with CDS).
--
-- Why: CDS keeps fleets in QuickBooks as sub-customers of the parent ("Acme:ACME - 297-...")
-- or as top-level customers named after it ("Torq by Acme - Tampa"), and had to add each
-- site to the portal by hand. Every hour (Vercel cron /api/cron/qbo-location-sync, and
-- "Sync now" on Admin > Locations) the portal reads the active QuickBooks customers and, for
-- each portal customer linked on Admin > QuickBooks mappings, links or creates a location per
-- site; the rules are in src/lib/qbo/location-sync.ts. Only the server writes, with the
-- service role: the cron has no login, and CDS's button runs on the server after requireCds().
--
-- 1. customer_locations.qbo_customer_id / qbo_customer_name: the QuickBooks customer that is
--    this site (the invoice goes to it directly), unique per portal customer. needs_setup:
--    true on a location the sync created, until it has a default shop (set on Admin >
--    Locations, or saved from the first dispatched order, see 4). Like every other location
--    column these are CDS only: customer_locations has no shop policy, shops never read it.
-- 2. qbo_location_sync_runs: one row per run (when, counts, what was created or linked, what
--    was skipped and why, errors). CDS reads it; a shop reads nothing; nobody signed in writes.
-- 3. qbo_location_sync_link / qbo_location_sync_create: the two writes of a run, service role
--    only, serialised per portal customer (advisory lock) so two runs at once never link or
--    create a site twice; the unique index is the last guard. They never change, deactivate
--    or delete an existing location beyond setting the QuickBooks customer of an unlinked one.
-- 4. cds_dispatch_work_order: dispatching an order for a location that needs setup saves that
--    order's shop and fulfillment as the location's defaults, once ("save the first
--    selection"). A trigger keeps needs_setup false whenever a default shop is set.
-- 5. app_settings "qbo_location_sync": the on/off switch, added off. Real runs (cron and
--    "Sync now") write only while it is {"enabled": true}; a dry run always works. CDS turns
--    it on with a one-row update after reviewing the dry-run count.
-- Every write goes through the existing audit trigger of customer_locations.

-- ---------------------------------------------------------------- 1. columns

alter table public.customer_locations
  add column qbo_customer_id text check (qbo_customer_id is null or (btrim(qbo_customer_id) <> '' and char_length(qbo_customer_id) <= 50)),
  add column qbo_customer_name text check (qbo_customer_name is null or char_length(qbo_customer_name) <= 500),
  add column needs_setup boolean not null default false;
alter table public.customer_locations
  add constraint customer_locations_qbo_name_with_id check ((qbo_customer_id is null) = (qbo_customer_name is null));
create unique index customer_locations_customer_qbo_key
  on public.customer_locations (customer_id, qbo_customer_id) where qbo_customer_id is not null;

-- A location with a default shop no longer needs setup (Admin > Locations, the dispatch below).
create function private.location_setup_done()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.needs_setup and new.default_affiliate_id is not null then
    new.needs_setup := false;
  end if;
  return new;
end $$;
create trigger setup_done before insert or update on public.customer_locations
  for each row execute function private.location_setup_done();

-- ---------------------------------------------------------------- 2. run record

create table public.qbo_location_sync_runs (
  id bigint generated always as identity primary key,
  trigger text not null check (trigger in ('cron', 'manual')),
  status text not null check (status in ('ok', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  qbo_customers integer not null default 0 check (qbo_customers >= 0),
  created integer not null default 0 check (created >= 0),
  linked integer not null default 0 check (linked >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  details jsonb not null default '{}'::jsonb,
  error text check (error is null or char_length(error) <= 2000)
);
create index qbo_location_sync_runs_finished_idx on public.qbo_location_sync_runs (finished_at desc);

alter table public.qbo_location_sync_runs enable row level security;
create policy cds_read on public.qbo_location_sync_runs for select to authenticated using ((select private.is_cds()));
revoke all on table public.qbo_location_sync_runs from public, anon, authenticated, service_role;
grant select on table public.qbo_location_sync_runs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_location_sync_runs to service_role;
revoke all on sequence public.qbo_location_sync_runs_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.qbo_location_sync_runs_id_seq to service_role;

-- ---------------------------------------------------------------- 3. sync writes

-- Sets the QuickBooks customer of a location that has none, when no other location of that
-- portal customer has it. Nothing else changes. True when it was set.
create function public.qbo_location_sync_link(p_location uuid, p_qbo_customer_id text, p_qbo_customer_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_id text := btrim(coalesce(p_qbo_customer_id, ''));
  v_name text := btrim(coalesce(p_qbo_customer_name, ''));
  v_customer uuid;
begin
  if v_id = '' or char_length(v_id) > 50 or v_name = '' or char_length(v_name) > 500 then
    raise exception 'A linked location needs its QuickBooks customer id and name' using errcode = 'P0001';
  end if;
  select l.customer_id into v_customer from public.customer_locations l where l.id = p_location;
  if not found then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('qbo_location_sync:' || v_customer::text, 0));
  if exists (select 1 from public.customer_locations l where l.customer_id = v_customer and l.qbo_customer_id = v_id) then
    return false;
  end if;
  update public.customer_locations
     set qbo_customer_id = v_id, qbo_customer_name = v_name
   where id = p_location and qbo_customer_id is null;
  return found;
end $$;
revoke all on function public.qbo_location_sync_link(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.qbo_location_sync_link(uuid, text, text) to service_role;

-- Creates the location of a QuickBooks site: pickup, no default shop, active, needs setup.
-- When the portal customer already has a location for this QuickBooks customer it creates
-- nothing and returns that one. A code already used by the customer gets "-2", "-3", ...
create function public.qbo_location_sync_create(p_location jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_customer uuid := (p_location ->> 'customer_id')::uuid;
  v_qbo_id text := btrim(coalesce(p_location ->> 'qbo_customer_id', ''));
  v_qbo_name text := btrim(coalesce(p_location ->> 'qbo_customer_name', ''));
  v_name text := left(btrim(coalesce(p_location ->> 'name', '')), 500);
  v_base text := left(upper(btrim(coalesce(p_location ->> 'code', ''))), 60);
  v_code text;
  v_existing uuid;
  v_new uuid;
  n integer := 1;
begin
  if v_qbo_id = '' or char_length(v_qbo_id) > 50 or v_qbo_name = '' or char_length(v_qbo_name) > 500 then
    raise exception 'A synced location needs its QuickBooks customer id and name' using errcode = 'P0001';
  end if;
  if v_name = '' or v_base = '' then
    raise exception 'A synced location needs a name and a code' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.customers c where c.id = v_customer) then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('qbo_location_sync:' || v_customer::text, 0));

  select l.id into v_existing from public.customer_locations l where l.customer_id = v_customer and l.qbo_customer_id = v_qbo_id;
  if found then
    return jsonb_build_object('id', v_existing, 'created', false);
  end if;

  v_code := v_base;
  while exists (select 1 from public.customer_locations l where l.customer_id = v_customer and upper(l.code) = v_code) loop
    n := n + 1;
    v_code := v_base || '-' || n;
  end loop;

  insert into public.customer_locations (
    customer_id, code, location_number, name, market, address_raw, address_line1, city, region, postal_code, country,
    default_affiliate_id, fulfillment, active, qbo_customer_id, qbo_customer_name, needs_setup)
  values (
    v_customer,
    v_code,
    nullif(btrim(coalesce(p_location ->> 'location_number', '')), ''),
    v_name,
    coalesce(nullif(p_location ->> 'market', ''), 'US')::public.market_code,
    btrim(coalesce(p_location ->> 'address_raw', '')),
    nullif(btrim(coalesce(p_location ->> 'address_line1', '')), ''),
    nullif(btrim(coalesce(p_location ->> 'city', '')), ''),
    nullif(upper(btrim(coalesce(p_location ->> 'region', ''))), ''),
    nullif(btrim(coalesce(p_location ->> 'postal_code', '')), ''),
    coalesce(nullif(btrim(coalesce(p_location ->> 'country', '')), ''), 'US'),
    null,
    'pickup',
    true,
    v_qbo_id,
    v_qbo_name,
    true
  )
  returning id into v_new;
  return jsonb_build_object('id', v_new, 'created', true, 'code', v_code);
end $$;
revoke all on function public.qbo_location_sync_create(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qbo_location_sync_create(jsonb) to service_role;

-- ---------------------------------------------------------------- 4. save the first selection

-- Same as 20261015020000_qa_round3_fixes.sql, plus: a location that needs setup gets this
-- order's shop and fulfillment (unless the order's is unspecified) as its defaults, once.
create or replace function public.cds_dispatch_work_order(p_work_order uuid, p_affiliate uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  shop record;
begin
  perform private.require_cds();
  select * into wo from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status not in ('pending_review', 'awaiting_acceptance', 'rejected_by_affiliate') then
    raise exception 'Only a work order in review or awaiting acceptance can be dispatched' using errcode = 'P0001';
  end if;
  select a.display_name into shop from public.affiliates a where a.id = p_affiliate and a.active;
  if not found then
    raise exception 'Choose an active shop' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.work_order_lines where work_order_id = wo.id) then
    raise exception 'Add at least one service or part before dispatch' using errcode = 'P0001';
  end if;

  update public.work_orders
     set affiliate_id = p_affiliate, status = 'awaiting_acceptance', dispatched_at = now()
   where id = wo.id;
  update public.work_order_internal
     set approved_by = auth.uid(),
         approved_by_name = (select p.full_name from public.profiles p where p.id = auth.uid()),
         approved_at = now(),
         review_reason = null
   where work_order_id = wo.id;
  if wo.location_id is not null then
    update public.customer_locations l
       set default_affiliate_id = p_affiliate,
           fulfillment = case when wo.fulfillment = 'unspecified' then l.fulfillment else wo.fulfillment end,
           needs_setup = false
     where l.id = wo.location_id and l.needs_setup;
  end if;
  perform private.log_event(wo.id, 'dispatch', wo.status, 'awaiting_acceptance',
    'Approved and dispatched to ' || shop.display_name, true);
end $$;

-- ---------------------------------------------------------------- 5. off until CDS turns it on

insert into public.app_settings (key, value) values ('qbo_location_sync', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;
