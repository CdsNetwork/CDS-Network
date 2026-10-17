-- QuickBooks items per customer, and measurement lines (2026-10-17).
--
-- CDS keeps its services as separate QuickBooks items per customer (for example
-- "EVACUFLUSH AND BAKE DPF - RYDER" and "EVACUFLUSH AND BAKE DPF - ENTERPRISE", each with
-- its own price and taxable flag), while parts are shared items.
--
-- 1. qbo_item_map gets an optional customer_id. A row without a customer is the mapping for
--    all customers; a row with one is that customer's own QuickBooks item. There is at most
--    one row for all customers and one row per customer for each catalog item. The invoice
--    uses the customer's row when there is one, else the row for all customers.
-- 2. qbo_measurement_map: the $0 "measurements" QuickBooks item per customer (or for all
--    customers) and component type, for example "DPF MEASUREMENTS & INFO-RYDER". Each
--    component on the work order becomes one $0 line with its readings. CDS only, like
--    the other mappings.

-- ---------------------------------------------------------------- items per customer

alter table public.qbo_item_map
  add column customer_id uuid references public.customers on delete cascade;

alter table public.qbo_item_map drop constraint qbo_item_map_catalog_item_id_key;

-- Nulls are not distinct: one row for all customers (customer_id null) per catalog item,
-- and one row per customer per catalog item. Upserts use on conflict (customer_id, catalog_item_id).
alter table public.qbo_item_map
  add constraint qbo_item_map_customer_item_key unique nulls not distinct (customer_id, catalog_item_id);

-- Invoice lookups go by catalog item (the unique index above leads with the customer).
create index qbo_item_map_catalog_item_idx on public.qbo_item_map (catalog_item_id);

-- ---------------------------------------------------------------- measurement lines

create table public.qbo_measurement_map (
  id uuid primary key default gen_random_uuid(),
  -- Null: for all customers.
  customer_id uuid references public.customers on delete cascade,
  component_type public.component_type not null,
  qbo_item_id text not null check (btrim(qbo_item_id) <> '' and char_length(qbo_item_id) <= 50),
  qbo_item_name text not null check (btrim(qbo_item_name) <> '' and char_length(qbo_item_name) <= 500),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now(),
  constraint qbo_measurement_map_customer_type_key unique nulls not distinct (customer_id, component_type)
);

alter table public.qbo_measurement_map enable row level security;
revoke all on public.qbo_measurement_map from anon;
revoke truncate, references, trigger on public.qbo_measurement_map from authenticated;
create policy cds_all on public.qbo_measurement_map for all to authenticated
  using ((select private.is_cds())) with check ((select private.is_cds()));
create trigger touch before update on public.qbo_measurement_map
  for each row execute function private.touch_updated_at();
create trigger audit after insert or update or delete on public.qbo_measurement_map
  for each row execute function private.audit();
