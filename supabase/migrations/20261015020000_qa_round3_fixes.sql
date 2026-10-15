-- QA round 3 fixes (2026-10-15).
--
-- When a login is deleted, every reference to it becomes null (20261015010000). The screens
-- then lost who approved an order or changed a price. Keep the person's name next to the
-- reference, written at the moment they acted, so it survives the login being deleted.

-- 1. Work order approver.
alter table public.work_order_internal add column approved_by_name text;

update public.work_order_internal wi
   set approved_by_name = p.full_name
  from public.profiles p
 where p.id = wi.approved_by
   and wi.approved_by_name is null;

-- Same as 20261014000000, plus the approver's name.
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
  perform private.log_event(wo.id, 'dispatch', wo.status, 'awaiting_acceptance',
    'Approved and dispatched to ' || shop.display_name, true);
end $$;

revoke all on function public.cds_dispatch_work_order(uuid, uuid) from public, anon;
grant execute on function public.cds_dispatch_work_order(uuid, uuid) to authenticated;

-- 2. Change log. actor_name is set whenever a signed-in person made the change, so a row
-- with actor_id null and a name was made by a login that has since been deleted, and a
-- row with neither was made by the system (service role, migrations).
alter table public.audit_log add column actor_name text;

update public.audit_log a
   set actor_name = p.full_name
  from public.profiles p
 where p.id = a.actor_id
   and a.actor_name is null;

create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  actor uuid := auth.uid();
begin
  insert into public.audit_log (actor_id, actor_name, table_name, row_id, action, old_data, new_data)
  values (
    actor,
    (select p.full_name from public.profiles p where p.id = actor),
    tg_table_name,
    coalesce(rec ->> 'id', rec ->> 'affiliate_id', rec ->> 'customer_id', rec ->> 'key', ''),
    lower(tg_op),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;
revoke all on function private.audit() from public;
