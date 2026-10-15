-- QuickBooks Online invoices (2026-10-16).
--
-- 1. The QuickBooks connection (OAuth tokens) lives in the private schema. Only the
--    service role reaches it, through functions that nobody else may execute. CDS staff
--    read whether QuickBooks is connected through public.qbo_connection_status(), which
--    never returns a token.
-- 2. Mappings from portal customers and catalog items to QuickBooks customers and items,
--    and a customer's own part numbers for our items (customer_item_aliases). CDS only.
-- 3. public.cds_mark_invoiced: records the QuickBooks invoice on the work order and moves
--    it from Ready to Invoice to Invoiced, in one step.

-- ---------------------------------------------------------------- connection (service role only)

-- One row: the portal talks to one QuickBooks company at a time. Tokens are encrypted by
-- the app before they are stored (src/lib/qbo/tokens.ts).
create table private.qbo_connection (
  singleton boolean primary key default true check (singleton),
  environment text not null check (environment in ('sandbox', 'production')),
  realm_id text not null,
  company_name text,
  -- Preferences.TaxPrefs.PartnerTaxEnabled: QuickBooks Automated Sales Tax is on.
  ast_enabled boolean,
  access_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token text not null,
  refresh_token_expires_at timestamptz,
  connected_by uuid references public.profiles on delete set null,
  connected_by_name text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger touch before update on private.qbo_connection for each row execute function private.touch_updated_at();

alter table private.qbo_connection enable row level security;
revoke all on private.qbo_connection from public, anon, authenticated;
grant select, insert, update, delete on private.qbo_connection to service_role;

-- The full row, tokens included, as JSON (null when not connected). Service role only.
create function public.qbo_get_connection()
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(c) from private.qbo_connection c where c.singleton
$$;

-- A new connection (after the OAuth callback). Replaces any earlier one.
create function public.qbo_save_connection(
  p_environment text,
  p_realm_id text,
  p_company_name text,
  p_ast_enabled boolean,
  p_access_token text,
  p_access_token_expires_at timestamptz,
  p_refresh_token text,
  p_refresh_token_expires_at timestamptz,
  p_connected_by uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare
  by_name text := (select p.full_name from public.profiles p where p.id = p_connected_by);
begin
  insert into private.qbo_connection as c
    (singleton, environment, realm_id, company_name, ast_enabled, access_token, access_token_expires_at,
     refresh_token, refresh_token_expires_at, connected_by, connected_by_name, connected_at)
  values
    (true, p_environment, p_realm_id, p_company_name, p_ast_enabled, p_access_token, p_access_token_expires_at,
     p_refresh_token, p_refresh_token_expires_at, p_connected_by, by_name, now())
  on conflict (singleton) do update
    set environment = excluded.environment, realm_id = excluded.realm_id, company_name = excluded.company_name,
        ast_enabled = excluded.ast_enabled, access_token = excluded.access_token,
        access_token_expires_at = excluded.access_token_expires_at, refresh_token = excluded.refresh_token,
        refresh_token_expires_at = excluded.refresh_token_expires_at, connected_by = excluded.connected_by,
        connected_by_name = excluded.connected_by_name, connected_at = excluded.connected_at;

  -- Change log entry without any token.
  insert into public.audit_log (actor_id, actor_name, table_name, row_id, action, old_data, new_data)
  values (p_connected_by, by_name, 'qbo_connection', p_realm_id, 'insert', null,
          jsonb_build_object('environment', p_environment, 'realm_id', p_realm_id, 'company_name', p_company_name));
end $$;

-- New tokens after a refresh. Only applies when the stored refresh token is still the one
-- the caller refreshed with, so two requests refreshing at once cannot overwrite a newer
-- token with an older one. Returns false when another request got there first.
create function public.qbo_save_tokens(
  p_realm_id text,
  p_previous_refresh_token text,
  p_access_token text,
  p_access_token_expires_at timestamptz,
  p_refresh_token text,
  p_refresh_token_expires_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update private.qbo_connection
     set access_token = p_access_token, access_token_expires_at = p_access_token_expires_at,
         refresh_token = p_refresh_token,
         refresh_token_expires_at = coalesce(p_refresh_token_expires_at, refresh_token_expires_at)
   where singleton and realm_id = p_realm_id and refresh_token = p_previous_refresh_token;
  return found;
end $$;

create function public.qbo_delete_connection(p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  old_row private.qbo_connection;
begin
  delete from private.qbo_connection where singleton returning * into old_row;
  if found then
    insert into public.audit_log (actor_id, actor_name, table_name, row_id, action, old_data, new_data)
    values (p_actor, (select p.full_name from public.profiles p where p.id = p_actor), 'qbo_connection', old_row.realm_id,
            'delete',
            jsonb_build_object('environment', old_row.environment, 'realm_id', old_row.realm_id,
                               'company_name', old_row.company_name),
            null);
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'qbo_get_connection()',
    'qbo_save_connection(text, text, text, boolean, text, timestamptz, text, timestamptz, uuid)',
    'qbo_save_tokens(text, text, text, timestamptz, text, timestamptz)',
    'qbo_delete_connection(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- What CDS staff may know about the connection: no tokens. Shops get an error.
create function public.qbo_connection_status()
returns table (
  connected boolean,
  environment text,
  company_name text,
  ast_enabled boolean,
  connected_at timestamptz,
  connected_by_name text
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_cds();
  return query
    select true, c.environment, c.company_name, c.ast_enabled, c.connected_at,
           coalesce((select p.full_name from public.profiles p where p.id = c.connected_by), c.connected_by_name)
    from private.qbo_connection c where c.singleton;
end $$;
revoke all on function public.qbo_connection_status() from public, anon;
grant execute on function public.qbo_connection_status() to authenticated;

-- ---------------------------------------------------------------- mappings (CDS only)

-- Mappings point into the QuickBooks company that is connected. After switching company
-- (sandbox to production), review them on the QuickBooks mappings tab.
create table public.qbo_customer_map (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.customers on delete cascade,
  qbo_customer_id text not null check (btrim(qbo_customer_id) <> '' and char_length(qbo_customer_id) <= 50),
  qbo_display_name text not null check (btrim(qbo_display_name) <> '' and char_length(qbo_display_name) <= 500),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);

create table public.qbo_item_map (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null unique references public.catalog_items on delete cascade,
  qbo_item_id text not null check (btrim(qbo_item_id) <> '' and char_length(qbo_item_id) <= 50),
  qbo_item_name text not null check (btrim(qbo_item_name) <> '' and char_length(qbo_item_name) <= 500),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);

-- A customer's own part number for one of our items (First Student invoices must show it).
create table public.customer_item_aliases (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers on delete cascade,
  catalog_item_id uuid not null references public.catalog_items on delete cascade,
  customer_part_number text not null
    check (btrim(customer_part_number) <> '' and char_length(customer_part_number) <= 100),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now(),
  unique (customer_id, catalog_item_id)
);
create index on public.customer_item_aliases (catalog_item_id);

do $$
declare t text;
begin
  foreach t in array array['qbo_customer_map', 'qbo_item_map', 'customer_item_aliases'] loop
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

-- ---------------------------------------------------------------- invoiced

-- Records the QuickBooks invoice and moves the order to Invoiced. Only from Ready to
-- Invoice, only once per work order (qb_invoice_id is also unique across orders).
create function public.cds_mark_invoiced(p_work_order uuid, p_qb_invoice_id text, p_qb_invoice_number text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  existing text;
begin
  perform private.require_cds();
  if coalesce(btrim(p_qb_invoice_id), '') = '' then
    raise exception 'The QuickBooks invoice id is missing' using errcode = 'P0001';
  end if;
  perform private.check_length(btrim(p_qb_invoice_id), 50);
  perform private.check_length(btrim(p_qb_invoice_number), 50);

  select * into wo from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status <> 'ready_to_invoice' then
    raise exception 'Only a work order that is Ready to Invoice can be invoiced' using errcode = 'P0001';
  end if;
  select i.qb_invoice_id into existing from public.work_order_internal i where i.work_order_id = wo.id for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if existing is not null and existing <> btrim(p_qb_invoice_id) then
    raise exception 'This work order already has QuickBooks invoice %', existing using errcode = 'P0001';
  end if;

  update public.work_order_internal
     set qb_invoice_id = btrim(p_qb_invoice_id),
         qb_invoice_number = nullif(btrim(p_qb_invoice_number), ''),
         invoiced_at = now()
   where work_order_id = wo.id;
  update public.work_orders set status = 'invoiced' where id = wo.id;
  perform private.log_event(wo.id, 'invoice', wo.status, 'invoiced',
    'QuickBooks invoice ' || coalesce(nullif(btrim(p_qb_invoice_number), ''), 'id ' || btrim(p_qb_invoice_id)) || ' created',
    false);
end $$;
revoke all on function public.cds_mark_invoiced(uuid, text, text) from public, anon;
grant execute on function public.cds_mark_invoiced(uuid, text, text) to authenticated;
