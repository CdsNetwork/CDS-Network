-- Voiding a label put the label status to "voided" but left the shipment status at
-- "label_created", so CDS and the shop saw "Label Created" with no label to print. A new
-- leg also started as "label_created" before any label existed.
--
-- New legs now start as "label_needed"; legs that have no label today move to it; and a void
-- moves a leg that the carrier has not picked up yet back to "label_needed". A leg the
-- carrier already scanned keeps its tracking status.

alter table public.shipments alter column status set default 'label_needed';

update public.shipments s
   set status = 'label_needed'
 where s.status = 'label_created'
   and s.label_status in ('needed', 'voided')
   and not exists (select 1 from public.shipment_labels l where l.shipment_id = s.id and l.status = 'active');

create or replace function public.cds_void_shipment_label(p_label uuid, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  l public.shipment_labels;
begin
  perform private.require_cds();
  perform private.check_length(p_message, 1000);
  select * into l from public.shipment_labels where id = p_label for update;
  if not found then
    raise exception 'Label not found' using errcode = 'P0002';
  end if;
  if l.status <> 'active' then
    raise exception 'This label is already voided' using errcode = 'P0001';
  end if;

  update public.shipment_labels
     set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_message = nullif(btrim(p_message), '')
   where id = l.id;
  update public.shipments
     set label_status = 'voided',
         status = case when status in ('label_created', 'awaiting_pickup', 'no_scan') then 'label_needed'::public.shipment_status
                       else status end,
         tracking_number = case when tracking_number is not distinct from l.tracking_number and not l.is_test then null else tracking_number end,
         carrier_shipment_id = null,
         label_file_path = null
   where id = l.shipment_id;
  if not l.is_test then
    update public.shipment_internal set actual_cost = null where shipment_id = l.shipment_id;
  end if;

  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status, error)
  values ('shipstation', 'label_void', l.shipment_id, l.shipstation_label_id, 'push', 'ok', nullif(btrim(p_message), ''));
  perform private.log_event(l.work_order_id, 'shipping_label', null, null,
    case when l.is_test then 'Test shipping label voided' else 'Shipping label voided' end
      || coalesce(' (tracking ' || l.tracking_number || ')', ''),
    true);
end $$;

revoke all on function public.cds_void_shipment_label(uuid, text) from public, anon;
grant execute on function public.cds_void_shipment_label(uuid, text) to authenticated;
