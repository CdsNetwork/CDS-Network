-- "Question Pending" flag (CDS, 2026-11-11). In CDS's Google Sheet a row turns hot pink when
-- Ryder (the customer) has a question that CDS must take to the shop and then answer back.
-- The portal keeps the same mark per work order: CDS switches it on (with an optional short
-- note of what the question is) and off on the work order page, the CDS work order list shows
-- a pink "Question Pending" badge and can show only those orders.
--
-- It is separate from the order status: setting or clearing it never changes the status.
--
-- CDS only. It lives in its own table, not on work_orders, because shops can read their own
-- work_orders rows (policy shop_read): a column there would be readable by the shop. This
-- table has no shop policy, so shops never see it, and nobody writes it through the API: the
-- function below does (security definer, CDS only), and every change is one audit_log row.

create table public.work_order_questions (
  work_order_id uuid primary key references public.work_orders on delete cascade,
  question_pending boolean not null default false,
  note text check (note is null or char_length(note) <= 500),
  -- Who switched it on last, and when.
  set_by uuid references public.profiles on delete set null,
  set_at timestamptz,
  -- Who switched it off last, and when.
  cleared_by uuid references public.profiles on delete set null,
  cleared_at timestamptz
);
create index work_order_questions_pending on public.work_order_questions (work_order_id) where question_pending;

-- Switches the flag on (with an optional note, replacing the previous one) or off. Turning it
-- on again while it is on only updates the note; turning it off while it is off does nothing.
create function public.cds_set_question_pending(p_work_order uuid, p_pending boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  prev public.work_order_questions;
  cur public.work_order_questions;
  clean_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform private.require_cds();
  if p_pending is null then
    raise exception 'Say whether the question is pending' using errcode = 'P0001';
  end if;
  if clean_note is not null and char_length(clean_note) > 500 then
    raise exception 'Keep the question note under 500 characters' using errcode = 'P0001';
  end if;
  perform 1 from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;

  select * into prev from public.work_order_questions where work_order_id = p_work_order;
  if p_pending then
    if prev.question_pending and prev.note is not distinct from clean_note then
      return;
    end if;
    insert into public.work_order_questions (work_order_id, question_pending, note, set_by, set_at)
    values (p_work_order, true, clean_note, auth.uid(), now())
    on conflict (work_order_id) do update
      set question_pending = true,
          note = excluded.note,
          set_by = case when public.work_order_questions.question_pending then public.work_order_questions.set_by else excluded.set_by end,
          set_at = case when public.work_order_questions.question_pending then public.work_order_questions.set_at else excluded.set_at end
    returning * into cur;
  else
    if not coalesce(prev.question_pending, false) then
      return;
    end if;
    update public.work_order_questions
       set question_pending = false, note = null, cleared_by = auth.uid(), cleared_at = now()
     where work_order_id = p_work_order
    returning * into cur;
  end if;

  insert into public.audit_log (actor_id, table_name, row_id, action, old_data, new_data)
  values (auth.uid(), 'work_order_questions', p_work_order::text,
          case when prev.work_order_id is null then 'insert' else 'update' end,
          case when prev.work_order_id is null then null else to_jsonb(prev) end,
          to_jsonb(cur));
end $$;

-- ---------------------------------------------------------------- access: CDS reads, nobody writes

alter table public.work_order_questions enable row level security;

create policy cds_read on public.work_order_questions for select to authenticated
  using ((select private.is_cds()));

-- Grants (20261020000000_explicit_api_grants.sql).
revoke all on table public.work_order_questions from public, anon, authenticated, service_role;
grant select on table public.work_order_questions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_questions to service_role;

revoke all on function public.cds_set_question_pending(uuid, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.cds_set_question_pending(uuid, boolean, text) to authenticated;
grant execute on function public.cds_set_question_pending(uuid, boolean, text) to service_role;
