-- CDS can delete a work order (a test order, or one entered twice) from its page.
--
-- Every CDS login is an admin (one cds_admin role in M1; profiles.kind is 'cds' or 'shop'),
-- so the rule is private.require_cds(). Shops cannot call this.
--
-- What goes with the order:
-- * Cascaded by the existing foreign keys: work_order_internal, lines and line pricing,
--   components, authorization requests and decisions, attachments rows, shipments with
--   shipment_internal, tracking events, labels, label costs, label tracking and pickups,
--   events (history), notes and internal notes.
-- * Done here: integration_sync rows about the order or its shipments and labels (they have
--   no foreign key), and inbound emails that created the order. The email stays in the inbox,
--   marked Not a request with the reason, so it is not lost and CDS can turn it into an order
--   again ("Treat as request").
-- * Stored files ('<work_order_id>/...' in wo-files): the app removes them after this returns
--   their paths, because storage objects cannot be deleted from SQL.
-- * One audit_log row keeps what was deleted, including any QuickBooks invoice reference.
--
-- QuickBooks is never touched: an invoice stays there and CDS voids it in QuickBooks.
-- An order with a real shipping label in use is refused: void the label first, so the
-- carrier charge is refunded and any pickup is cancelled. Test labels go with the order.
-- Other orders are not affected: every delete is keyed on this order's id.

create function public.cds_delete_work_order(p_work_order uuid)
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

revoke all on function public.cds_delete_work_order(uuid) from public, anon;
grant execute on function public.cds_delete_work_order(uuid) to authenticated, service_role;
