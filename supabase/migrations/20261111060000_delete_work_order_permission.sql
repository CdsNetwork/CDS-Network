-- Deleting a work order is limited to Sarah (CDS, 2026-11-11).
--
-- profiles.can_delete_work_orders says who may delete. This migration turns it on for the
-- profile with the email sarah@cds.direct only; every other profile, CDS or shop, has it off.
-- public.cds_delete_work_order (20261111020000_delete_work_order.sql) now also refuses any
-- caller without it, and the work order page shows the Delete control only to those with it.
--
-- Nobody can give the permission to themselves or anyone else through the API: CDS logins
-- may update profiles (policy cds_all) and shops may not update them at all, but the trigger
-- below refuses any change to the column made by an API login (anon or authenticated). It is
-- changed only by a migration or the service role. Only a CDS profile can have it.

alter table public.profiles
  add column can_delete_work_orders boolean not null default false,
  add constraint profiles_delete_permission_cds_only check (not can_delete_work_orders or kind = 'cds');

update public.profiles set can_delete_work_orders = true where email = 'sarah@cds.direct' and kind = 'cds';

-- Security invoker on purpose: current_user is then the API role of the caller. A security
-- definer function (a trusted database function) runs as the owner and is let through.
create function private.guard_profile_permissions() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated')
     and ((tg_op = 'INSERT' and new.can_delete_work_orders)
          or (tg_op = 'UPDATE' and new.can_delete_work_orders is distinct from old.can_delete_work_orders)) then
    raise exception 'The delete permission cannot be changed here' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.guard_profile_permissions() from public;

create trigger guard_permissions before insert or update on public.profiles
  for each row execute function private.guard_profile_permissions();

-- The delete function, unchanged except the permission check after require_cds. Its grants
-- stay as they were (create or replace keeps them).
create or replace function public.cds_delete_work_order(p_work_order uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  invoice_id text;
  invoice_number text;
  sync_note text;
  paths text[];
  shipment_ids uuid[];
  label_ids uuid[];
begin
  perform private.require_cds();
  if not coalesce((select p.can_delete_work_orders from public.profiles p where p.id = auth.uid()), false) then
    raise exception 'Only Sarah can delete work orders. Ask her to delete this one.' using errcode = '42501';
  end if;
  select * into wo from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.shipment_labels l
    where l.work_order_id = wo.id and l.status = 'active' and not l.is_test
  ) then
    raise exception 'This work order has a shipping label in use. Void the label first, then delete the work order.'
      using errcode = 'P0001';
  end if;

  -- The QuickBooks invoice: recorded on the order, else one created but not yet recorded
  -- (src/lib/qbo/pending.ts).
  select i.qb_invoice_id, i.qb_invoice_number into invoice_id, invoice_number
  from public.work_order_internal i where i.work_order_id = wo.id;
  if invoice_id is null then
    select s.external_id, s.error into invoice_id, sync_note
    from public.integration_sync s
    where s.system = 'quickbooks' and s.entity = 'invoice' and s.entity_id = wo.id
      and s.status = 'ok' and s.external_id is not null
    order by s.at desc limit 1;
    if sync_note like 'QuickBooks invoice number %' then
      invoice_number := nullif(btrim(substr(sync_note, length('QuickBooks invoice number ') + 1)), '');
    end if;
  end if;

  shipment_ids := array(select sh.id from public.shipments sh where sh.work_order_id = wo.id);
  label_ids := array(select l.id from public.shipment_labels l where l.work_order_id = wo.id);
  paths := array(
    select a.storage_path from public.attachments a where a.work_order_id = wo.id
    union
    select l.label_file_path from public.shipment_labels l where l.work_order_id = wo.id and l.label_file_path is not null
    union
    select sh.label_file_path from public.shipments sh where sh.work_order_id = wo.id and sh.label_file_path is not null
  );

  insert into public.audit_log (actor_id, table_name, row_id, action, old_data)
  values (
    auth.uid(), 'work_orders', wo.id::text, 'delete',
    to_jsonb(wo) || jsonb_build_object(
      'qb_invoice_id', invoice_id,
      'qb_invoice_number', invoice_number,
      'shipment_ids', to_jsonb(shipment_ids),
      'label_ids', to_jsonb(label_ids),
      'storage_paths', to_jsonb(paths))
  );

  update public.inbound_emails e
     set work_order_id = null,
         status = 'ignored',
         parsed = coalesce(e.parsed, '{}'::jsonb)
                  || jsonb_build_object('ignore_reason', format('Its work order WO-%s was deleted.', wo.wo_number))
   where e.work_order_id = wo.id;

  delete from public.integration_sync s
   where s.entity_id = wo.id or s.entity_id = any (shipment_ids) or s.entity_id = any (label_ids);

  delete from public.work_orders where id = wo.id;

  return jsonb_build_object(
    'wo_number', wo.wo_number,
    'qb_invoice_id', invoice_id,
    'qb_invoice_number', invoice_number,
    'storage_paths', to_jsonb(paths));
end $$;
