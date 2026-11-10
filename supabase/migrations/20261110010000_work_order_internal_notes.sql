-- Internal notes on a work order: a history only CDS staff ever see.
--
-- The CDS-only counterpart of public.work_order_notes (20261109000000_work_order_notes.sql),
-- like the notes column on the office's tracking sheet: anyone on CDS staff adds a note at
-- any time, saved with the author's name and the time. Shops never read or add one: there
-- are no shop policies on this table at all. CDS may delete a note posted by mistake (kept
-- in the change log). Nobody edits a note.
--
-- The existing one-off field work_order_internal.internal_notes stays as is: it is written
-- when the order is created (by hand or from the intake email) and the work order page shows
-- it as the first entry of this history.
--
-- * author_id is always the caller (RLS) and is set to null when that login is deleted
--   (20261015010000_profile_references_set_null.sql); author_name keeps the name, stored by
--   the trigger below from profiles.full_name, whatever the caller sends.
-- * body is trimmed and must be 1 to 2000 characters.

create table public.work_order_internal_notes (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders on delete cascade,
  author_id uuid references public.profiles on delete set null default auth.uid(),
  author_name text not null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint work_order_internal_notes_body_len check (char_length(body) between 1 and 2000
                                                       and body = btrim(body, E' \t\r\n'))
);
create index on public.work_order_internal_notes (work_order_id, created_at);

create function private.work_order_internal_note_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.body := btrim(new.body, E' \t\r\n');
  new.author_name := coalesce((select p.full_name from public.profiles p where p.id = new.author_id), 'Unknown');
  new.created_at := now();
  return new;
end $$;
revoke all on function private.work_order_internal_note_defaults() from public;

create trigger defaults before insert on public.work_order_internal_notes
  for each row execute function private.work_order_internal_note_defaults();

-- A deleted note is kept in the change log.
create trigger audit after delete on public.work_order_internal_notes
  for each row execute function private.audit();

alter table public.work_order_internal_notes enable row level security;

-- CDS only. No shop policies: a shop reads and adds nothing here, on any work order.
create policy cds_read on public.work_order_internal_notes for select to authenticated
  using ((select private.is_cds()));
create policy cds_insert on public.work_order_internal_notes for insert to authenticated
  with check ((select private.is_cds()) and author_id = (select auth.uid()));
create policy cds_delete on public.work_order_internal_notes for delete to authenticated
  using ((select private.is_cds()));

-- Grants (20261020000000_explicit_api_grants.sql). No UPDATE for anyone: notes are never
-- edited. Every row is limited to CDS by the policies above.
revoke all on table public.work_order_internal_notes from public, anon, authenticated, service_role;
grant delete, insert, select on table public.work_order_internal_notes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_internal_notes to service_role;
