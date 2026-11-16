-- Edit an internal note (Sarah, CDS, 2026-11-13; milestone M3: notes from the work order list).
--
-- Why: the tracking sheet's notes column is edited in place. Until now nobody could edit a
-- note (20261110010000_work_order_internal_notes.sql). From now on the author of a CDS-only
-- internal note may correct its text. Notes the shop sees (work_order_notes) stay as they
-- are: nobody edits them, so what a shop reads never changes under it.
--
-- * work_order_internal_notes.edited_at: when the text was last changed; null if never.
-- * public.cds_edit_internal_note(note, body): CDS only, and only the note's author. The body
--   is trimmed and must be 1 to 2000 characters (the table's check). Same text: nothing
--   changes. Author, name, time and order of the note never change.
-- * Every edit is kept in the change log (audit_log, old and new row), like a delete.
-- * Grants: the table keeps its grants (no UPDATE for anyone); the edit goes only through the
--   function, so a direct update is still refused.

alter table public.work_order_internal_notes add column edited_at timestamptz;

comment on column public.work_order_internal_notes.edited_at is
  'When the author last changed the text (public.cds_edit_internal_note); null if never edited.';

create function public.cds_edit_internal_note(p_note uuid, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  n public.work_order_internal_notes;
  clean text := btrim(replace(replace(coalesce(p_body, ''), E'\r\n', E'\n'), E'\r', E'\n'), E' \t\r\n');
begin
  perform private.require_cds();
  select * into n from public.work_order_internal_notes where id = p_note for update;
  if not found then
    raise exception 'Note not found' using errcode = 'P0002';
  end if;
  if n.author_id is distinct from auth.uid() then
    raise exception 'Only the person who wrote a note can edit it' using errcode = '42501';
  end if;
  if clean = '' then
    raise exception 'Write a note first' using errcode = 'P0001';
  end if;
  perform private.check_length(clean, 2000);
  if clean = n.body then
    return;
  end if;
  update public.work_order_internal_notes set body = clean, edited_at = now() where id = n.id;
end $$;

-- An edited note is kept in the change log (old and new text).
create trigger audit_update after update on public.work_order_internal_notes
  for each row execute function private.audit();

-- Grants (20261020000000_explicit_api_grants.sql).
revoke all on function public.cds_edit_internal_note(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.cds_edit_internal_note(uuid, text) to authenticated;
grant execute on function public.cds_edit_internal_note(uuid, text) to service_role;
