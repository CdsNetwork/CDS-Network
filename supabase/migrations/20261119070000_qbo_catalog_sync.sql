-- Catalog sync from QuickBooks (2026-11-19).
--
-- Why: a part in QuickBooks (ENV-NOX-1632) was missing in the portal, whose catalog was only
-- edited by hand. The portal now reads the QuickBooks items every hour (Vercel cron
-- /api/cron/qbo-catalog-sync, and "Sync now" on the Catalog page) and adds what is missing;
-- the rules are in src/lib/qbo/catalog-sync.ts. Only the server writes, with the service
-- role: the cron has no login, and CDS's button runs on the server after requireCds().
--
-- 1. qbo_catalog_sync_runs: one row per run (when, counts, what was created or linked, what
--    was skipped and why, differences, errors). CDS reads it (the status line on the Catalog
--    page); a shop reads nothing; nobody signed in writes it.
-- 2. public.qbo_catalog_sync_create_item(item jsonb): creates the catalog item, its Fleet
--    Price and default Shop Rate from today (only prices above 0), and its default QuickBooks
--    link, all at once. A SKU that exists already creates nothing and returns that item.
-- 3. public.qbo_catalog_sync_link(item, qbo id, qbo name): the default link (all customers)
--    of an item that has none; never replaces one.
-- 4. public.qbo_catalog_sync_rename(qbo id, qbo name): updates the stored QuickBooks name of
--    the links to that QuickBooks item. Portal names and prices are never changed here.
-- Every write goes through the existing audit triggers (catalog_items, sell_prices,
-- shop_rates, qbo_item_map), with no actor (the server). Nothing is ever deleted.

create table public.qbo_catalog_sync_runs (
  id bigint generated always as identity primary key,
  trigger text not null check (trigger in ('cron', 'manual')),
  status text not null check (status in ('ok', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  qbo_items integer not null default 0 check (qbo_items >= 0),
  created integer not null default 0 check (created >= 0),
  linked integer not null default 0 check (linked >= 0),
  renamed integer not null default 0 check (renamed >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  differences integer not null default 0 check (differences >= 0),
  details jsonb not null default '{}'::jsonb,
  error text check (error is null or char_length(error) <= 2000)
);
create index qbo_catalog_sync_runs_finished_idx on public.qbo_catalog_sync_runs (finished_at desc);

alter table public.qbo_catalog_sync_runs enable row level security;
create policy cds_read on public.qbo_catalog_sync_runs for select to authenticated using ((select private.is_cds()));
revoke all on table public.qbo_catalog_sync_runs from public, anon, authenticated, service_role;
grant select on table public.qbo_catalog_sync_runs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_catalog_sync_runs to service_role;
revoke all on sequence public.qbo_catalog_sync_runs_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.qbo_catalog_sync_runs_id_seq to service_role;

create function public.qbo_catalog_sync_create_item(p_item jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  today date := private.today();
  v_sku text := upper(btrim(coalesce(p_item ->> 'sku', '')));
  v_name text := btrim(coalesce(p_item ->> 'name', ''));
  v_qbo_id text := btrim(coalesce(p_item ->> 'qbo_item_id', ''));
  v_qbo_name text := btrim(coalesce(p_item ->> 'qbo_item_name', ''));
  v_sell numeric := nullif(p_item ->> 'sell_price', '')::numeric;
  v_rate numeric := nullif(p_item ->> 'shop_rate', '')::numeric;
  new_id uuid;
begin
  if v_sku = '' or char_length(v_sku) > 100 then
    raise exception 'A synced item needs a SKU of at most 100 characters' using errcode = 'P0001';
  end if;
  if v_name = '' or char_length(v_name) > 500 then
    raise exception 'A synced item needs a name of at most 500 characters' using errcode = 'P0001';
  end if;
  if v_qbo_id = '' or char_length(v_qbo_id) > 50 or v_qbo_name = '' or char_length(v_qbo_name) > 500 then
    raise exception 'A synced item needs its QuickBooks item id and name' using errcode = 'P0001';
  end if;
  if (v_sell is not null and v_sell < 0) or (v_rate is not null and v_rate < 0) then
    raise exception 'A price cannot be negative' using errcode = 'P0001';
  end if;

  insert into public.catalog_items (sku, category, name, tax_class, shop_selectable, active, pass_through, price_per_line)
  values (
    v_sku,
    (p_item ->> 'category')::public.catalog_category,
    v_name,
    (p_item ->> 'tax_class')::public.tax_class,
    coalesce((p_item ->> 'shop_selectable')::boolean, true),
    true,
    coalesce((p_item ->> 'pass_through')::boolean, true),
    coalesce((p_item ->> 'price_per_line')::boolean, false)
  )
  on conflict (sku) do nothing
  returning id into new_id;

  if new_id is null then
    return jsonb_build_object('id', (select c.id from public.catalog_items c where c.sku = v_sku), 'created', false);
  end if;

  if v_sell > 0 then
    insert into public.sell_prices (catalog_item_id, market, amount, effective_from) values (new_id, 'US', v_sell, today);
  end if;
  if v_rate > 0 then
    insert into public.shop_rates (catalog_item_id, market, amount, effective_from) values (new_id, 'US', v_rate, today);
  end if;
  insert into public.qbo_item_map (customer_id, catalog_item_id, qbo_item_id, qbo_item_name)
  values (null, new_id, v_qbo_id, v_qbo_name);
  return jsonb_build_object('id', new_id, 'created', true);
end $$;
revoke all on function public.qbo_catalog_sync_create_item(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qbo_catalog_sync_create_item(jsonb) to service_role;

create function public.qbo_catalog_sync_link(p_catalog_item uuid, p_qbo_item_id text, p_qbo_item_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.qbo_item_map (customer_id, catalog_item_id, qbo_item_id, qbo_item_name)
  values (null, p_catalog_item, btrim(p_qbo_item_id), btrim(p_qbo_item_name))
  on conflict on constraint qbo_item_map_customer_item_key do nothing;
  return found;
end $$;
revoke all on function public.qbo_catalog_sync_link(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.qbo_catalog_sync_link(uuid, text, text) to service_role;

create function public.qbo_catalog_sync_rename(p_qbo_item_id text, p_qbo_item_name text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if coalesce(btrim(p_qbo_item_name), '') = '' then
    raise exception 'The QuickBooks name is missing' using errcode = 'P0001';
  end if;
  update public.qbo_item_map set qbo_item_name = btrim(p_qbo_item_name)
   where qbo_item_id = btrim(p_qbo_item_id) and qbo_item_name is distinct from btrim(p_qbo_item_name);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.qbo_catalog_sync_rename(text, text) from public, anon, authenticated, service_role;
grant execute on function public.qbo_catalog_sync_rename(text, text) to service_role;
