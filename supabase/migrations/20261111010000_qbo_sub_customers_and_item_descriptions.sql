-- QuickBooks invoices: site sub-customers and invoice text per item (2026-11-11).
--
-- 1. qbo_location_customer_map: the QuickBooks sub-customer found for a location (for
--    example Ryder site 297 -> "Ryder Fleet Services:RYDER - 297-COLORADO SPRINGS CO"). The
--    portal looks the sub-customer up in QuickBooks when it creates an invoice (by the site
--    number, among the sub-customers of the customer's mapped QuickBooks parent) and
--    remembers it here, so the next invoice for the site only checks that it still belongs
--    to the same parent. qbo_parent_id is the parent it was found under: after the customer
--    is linked to another QuickBooks customer the row is no longer used. CDS only.
-- 2. qbo_item_descriptions: the description the invoice line gets for a QuickBooks item,
--    instead of the portal's item name (a customer's own description with its part number
--    still comes first). Keyed by the QuickBooks item name without case or spaces, so it
--    holds for the sandbox and the production company and survives re-linking the item.
--    CDS only. Seeded with Ryder's text for "EVACUFLUSH AND BAKE DPF - RYDER".

-- ---------------------------------------------------------------- sub-customers per location

create table public.qbo_location_customer_map (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null unique references public.customer_locations on delete cascade,
  qbo_parent_id text not null check (btrim(qbo_parent_id) <> '' and char_length(qbo_parent_id) <= 50),
  qbo_customer_id text not null check (btrim(qbo_customer_id) <> '' and char_length(qbo_customer_id) <= 50),
  qbo_display_name text not null check (btrim(qbo_display_name) <> '' and char_length(qbo_display_name) <= 500),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- invoice text per item

create table public.qbo_item_descriptions (
  id uuid primary key default gen_random_uuid(),
  qbo_item_name text not null check (btrim(qbo_item_name) <> '' and char_length(qbo_item_name) <= 500),
  description text not null check (btrim(description) <> '' and char_length(description) <= 4000),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);
-- Same key as the app (itemDescriptionKey in src/lib/qbo/invoice-qbo.ts).
create unique index qbo_item_descriptions_name_key
  on public.qbo_item_descriptions (upper(regexp_replace(qbo_item_name, '\s', '', 'g')));

do $$
declare t text;
begin
  foreach t in array array['qbo_location_customer_map', 'qbo_item_descriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy cds_all on public.%I for all to authenticated using ((select private.is_cds())) with check ((select private.is_cds()))', t);
    execute format('create trigger touch before update on public.%I for each row execute function private.touch_updated_at()', t);
    execute format(
      'create trigger audit after insert or update or delete on public.%I for each row execute function private.audit()', t);
    -- Grants (20261020000000_explicit_api_grants.sql), the same as the other QuickBooks mappings.
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant delete, insert, maintain, select, update on table public.%I to authenticated', t);
    execute format(
      'grant delete, insert, maintain, references, select, trigger, truncate, update on table public.%I to service_role', t);
  end loop;
end $$;

insert into public.qbo_item_descriptions (qbo_item_name, description)
values (
  'EVACUFLUSH AND BAKE DPF - RYDER',
  'Place Diesel Particulate Filter (DPF) in EvacuBlast cabinet, test differential pressure for restriction, weigh filter, wash filter using aqueous procedure, place plugged filter in Bake oven for regeneration, perform evacublast cleaning, retest differential pressure to ensure proper flow rate, weigh the filter again to determine how much soot was removed.'
)
on conflict do nothing;
