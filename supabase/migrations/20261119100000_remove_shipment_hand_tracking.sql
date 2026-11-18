-- Remove a shipment leg with a tracking number typed by hand (Sarah, CDS, 2026-11-18: "Ability
-- to delete shipment information (for when we make mistakes on a label)").
--
-- public.cds_remove_shipment (20261118040000_remove_shipment_rpc.sql) refused any leg with a
-- tracking number or a label status other than needed or voided, so a leg added by mistake
-- with a tracking number typed in the Add shipment form (label status Ready) could never be
-- removed. Now, under the same locks:
--   * still refused: the order is invoiced (or has a QuickBooks invoice), and the leg has a
--     label in use (status active). The work order page voids that label first ("Void label
--     and remove"), through the usual void path, and only then removes the leg.
--   * new refusal: a label is being bought for the leg right now (a live 'label' claim in
--     private.shipstation_claims, 20261116030000_shipstation_claims.sql; claims expire after
--     5 minutes). This replaces the label status check, which stood for "a label is being
--     made".
--   * no longer refused: a tracking number and any label status on a leg with no label in
--     use. A voided portal label clears its tracking number (cds_void_shipment_label), so a
--     tracking number left on such a leg was typed by hand.
-- The leg's notes, costs, tracking events and voided labels go with it (cascade), and the
-- removal is logged on the order, as before. Grants restated unchanged.

create or replace function public.cds_remove_shipment(p_work_order uuid, p_shipment uuid)
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
  if exists (
    select 1 from private.shipstation_claims c
     where c.kind = 'label' and c.target = s.id and c.claimed_at >= now() - interval '5 minutes'
  ) then
    raise exception 'A label is being created for this shipment. Refresh in a moment, then try again.'
      using errcode = 'P0001';
  end if;

  delete from public.shipments where id = s.id;
  insert into public.work_order_events (work_order_id, actor_id, event_type, message, shop_visible)
  values (wo.id, auth.uid(), 'shipment',
          'Shipment removed: ' || coalesce(s.carrier, 'carrier not set') || coalesce(' ' || nullif(btrim(s.tracking_number), ''), ''),
          false);
end $$;

revoke all on function public.cds_remove_shipment(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_remove_shipment(uuid, uuid) to authenticated;
grant execute on function public.cds_remove_shipment(uuid, uuid) to service_role;
