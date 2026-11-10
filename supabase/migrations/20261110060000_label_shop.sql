-- Shipping labels made before dispatch (CDS, 2026-11-10: "they usually prep the shipping
-- label before they dispatch it").
--
-- While a work order is in review it has no shop yet (or the one it was sent back with), so
-- the app addresses a leg to or from the shop to the "planned shop": the shop Review &
-- Dispatch offers by default (the order's shop when it was sent back to review, else the
-- location's default shop). The app works that out; nothing about it is stored on the order.
--
-- What is stored is the shop each label was made for: shipment_labels.shop_affiliate_id
-- (null for legs between CDS and the customer, and for labels made before this change). The
-- work order page compares it with the order's shop (or planned shop) and warns CDS when the
-- order went to another shop, so the label can be voided and made again. Dispatch is never
-- blocked by it.
--
-- The column follows the table's policies: CDS reads every label, a shop only the labels on
-- its own work orders (which already show the label's ship-to). It is written only by
-- public.cds_record_shipment_label, like every other column of the table.

alter table public.shipment_labels
  add column shop_affiliate_id uuid references public.affiliates on delete set null;

comment on column public.shipment_labels.shop_affiliate_id is
  'The shop whose address is on the label (the shop end of the leg), or null for legs without a shop end.';

-- p_label gains the optional key shop_affiliate_id (see 20261018000000_shipstation.sql for
-- the others). The rest of the function is unchanged.
create or replace function public.cds_record_shipment_label(p_shipment uuid, p_label jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  sh public.shipments;
  car public.shipping_carriers;
  new_label uuid;
  test boolean := coalesce((p_label ->> 'is_test')::boolean, true);
  tracking text := nullif(btrim(p_label ->> 'tracking_number'), '');
  service text := coalesce(nullif(btrim(p_label ->> 'service_name'), ''), p_label ->> 'service_code');
  total numeric(12,2) := coalesce((p_label ->> 'label_cost')::numeric, 0) + coalesce((p_label ->> 'insurance_cost')::numeric, 0);
  shop uuid := nullif(btrim(p_label ->> 'shop_affiliate_id'), '')::uuid;
begin
  perform private.require_cds();
  select * into sh from public.shipments where id = p_shipment for update;
  if not found then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;
  select * into car from public.shipping_carriers where shipstation_carrier_id = p_label ->> 'shipstation_carrier_id';
  if not found then
    raise exception 'Unknown carrier %', p_label ->> 'shipstation_carrier_id' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shipment_labels l where l.shipment_id = sh.id and l.status = 'active') then
    raise exception 'This shipment already has a label. Void it before creating another.' using errcode = 'P0001';
  end if;
  if shop is not null and not exists (select 1 from public.affiliates a where a.id = shop) then
    raise exception 'Unknown shop %', shop using errcode = 'P0001';
  end if;

  insert into public.shipment_labels
    (shipment_id, work_order_id, shipstation_label_id, shipstation_shipment_id, shipstation_carrier_id, carrier,
     service_code, service_name, tracking_number, tracking_url, is_test, label_file_path, label_url,
     ship_from_summary, ship_to_summary, shop_affiliate_id, created_by)
  values
    (sh.id, sh.work_order_id, p_label ->> 'shipstation_label_id', p_label ->> 'shipstation_shipment_id',
     car.shipstation_carrier_id, car.carrier, p_label ->> 'service_code', left(service, 100), tracking,
     nullif(p_label ->> 'tracking_url', ''), test, nullif(p_label ->> 'label_file_path', ''), nullif(p_label ->> 'label_url', ''),
     left(p_label ->> 'ship_from_summary', 500), left(p_label ->> 'ship_to_summary', 500), shop, auth.uid())
  returning id into new_label;

  insert into public.shipment_label_costs
    (label_id, rate_id, quoted_total, label_cost, insurance_cost, currency, delivery_days, estimated_delivery)
  values
    (new_label, nullif(p_label ->> 'rate_id', ''), (p_label ->> 'quoted_total')::numeric,
     coalesce((p_label ->> 'label_cost')::numeric, 0), coalesce((p_label ->> 'insurance_cost')::numeric, 0),
     coalesce(upper(nullif(p_label ->> 'currency', '')), 'USD'), (p_label ->> 'delivery_days')::int,
     (p_label ->> 'estimated_delivery')::timestamptz);

  update public.shipments
     set carrier = car.carrier,
         service_level = left(service, 100),
         tracking_number = case when test then tracking_number else tracking end,
         label_status = 'ready',
         status = 'label_created',
         label_file_path = nullif(p_label ->> 'label_file_path', ''),
         carrier_shipment_id = p_label ->> 'shipstation_shipment_id',
         eta_text = coalesce(
           case when (p_label ->> 'delivery_days') is not null
                then (p_label ->> 'delivery_days') || ' business day' || case when (p_label ->> 'delivery_days') = '1' then '' else 's' end
           end, eta_text)
   where id = sh.id;

  if not test then
    insert into public.shipment_internal (shipment_id, quoted_cost, actual_cost)
    values (sh.id, (p_label ->> 'quoted_total')::numeric, total)
    on conflict (shipment_id) do update
      set quoted_cost = coalesce(excluded.quoted_cost, public.shipment_internal.quoted_cost),
          actual_cost = excluded.actual_cost;
  end if;

  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status)
  values ('shipstation', 'label', sh.id, p_label ->> 'shipstation_label_id', 'push', case when test then 'test' else 'ok' end);

  perform private.log_event(sh.work_order_id, 'shipping_label', null, null,
    case when test then 'Test shipping label created: ' else 'Shipping label created: ' end
      || car.carrier || ' ' || coalesce(service, '') || coalesce(', tracking ' || tracking, ''),
    true);
  return new_label;
end $$;

-- create or replace keeps the grants (20261020000000_explicit_api_grants.sql); restated.
revoke all on function public.cds_record_shipment_label(uuid, jsonb) from public, anon;
grant execute on function public.cds_record_shipment_label(uuid, jsonb) to authenticated;
