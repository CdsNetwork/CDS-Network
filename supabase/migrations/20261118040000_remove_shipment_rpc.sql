-- A shipment is removed only through public.cds_remove_shipment (review 2026-11-16).
--
-- 20261020000000_explicit_api_grants.sql granted DELETE on public.shipments to authenticated,
-- and policy cds_all lets every CDS login delete any shipment with a plain DELETE through the
-- Data API. The checks of the Remove button (removeShipment in
-- src/app/cds/work-orders/[id]/actions.ts) ran only in the app: the order is not invoiced, the
-- shipment has no label in use, no tracking number, and its label status says no label
-- (needed or voided).
--
-- public.cds_remove_shipment(order, shipment) (CDS only) locks the order and the shipment,
-- makes the same checks with the same messages, deletes the shipment (its notes, costs,
-- tracking events and voided labels go with it, as before) and logs the removal on the order.
-- DELETE on public.shipments is revoked from authenticated; the app has no other direct
-- delete. Security definer functions (cds_delete_work_order), cascades and the service role
-- are not affected. tests/rls/grants.snapshot.json updated.

create function public.cds_remove_shipment(p_work_order uuid, p_shipment uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  s public.shipments;
begin
  perform private.require_cds();
  select * into wo from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Shipment not found.' using errcode = 'P0002';
  end if;
  select * into s from public.shipments where id = p_shipment and work_order_id = wo.id for update;
  if not found then
    raise exception 'Shipment not found.' using errcode = 'P0002';
  end if;
  if private.wo_invoiced(wo.id) then
    raise exception 'Shipments cannot be removed after the order is invoiced.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shipment_labels l where l.shipment_id = s.id and l.status = 'active') then
    raise exception 'This shipment has a label. Void the label first, then remove the shipment.' using errcode = 'P0001';
  end if;
  if nullif(btrim(s.tracking_number), '') is not null then
    raise exception 'This shipment has a tracking number, so it cannot be removed.' using errcode = 'P0001';
  end if;
  if s.label_status not in ('needed', 'voided') then
    raise exception 'This shipment has a label or one is being made. Void the label first, then remove the shipment.'
      using errcode = 'P0001';
  end if;

  delete from public.shipments where id = s.id;
  insert into public.work_order_events (work_order_id, actor_id, event_type, message, shop_visible)
  values (wo.id, auth.uid(), 'shipment', 'Shipment removed: ' || coalesce(s.carrier, 'carrier not set'), false);
end $$;

revoke all on function public.cds_remove_shipment(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_remove_shipment(uuid, uuid) to authenticated;
grant execute on function public.cds_remove_shipment(uuid, uuid) to service_role;

revoke delete on table public.shipments from authenticated;
