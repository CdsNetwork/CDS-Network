-- UPS by Worldwide Express: CDS's UPS account through Worldwide Express (contracted rates),
-- connected in ShipStation by CDS. CDS asked (2026-11-13) for FedEx and UPS rates side by side
-- when making a label, so this carrier is turned on next to FedEx.
--
-- ShipStation (GET /v2/carriers, read 2026-11-15): carrier_id se-7177883, carrier_code
-- wwex_parcel, friendly_name "UPS by Worldwide Express". Only its domestic services are added;
-- labels carry UPS 1Z tracking numbers, so the carrier is 'UPS'. ShipStation's own UPS rates
-- (se-7157770) are not touched and stay off.
--
-- api_pickups: whether ShipStation can book a carrier pickup for this carrier's labels.
-- ShipStation's guide for UPS by Worldwide Express says to ask Worldwide Express about pickup
-- scheduling and that pickup cancellation is not supported through the API, so the portal
-- does not book pickups for it and tells CDS to book them with Worldwide Express or UPS.
--
-- Safe to run more than once: the carrier row is updated in place, and services that already
-- exist keep their on or off setting.

alter table public.shipping_carriers
  add column if not exists api_pickups boolean not null default true;

comment on column public.shipping_carriers.api_pickups is
  'Whether ShipStation can book a carrier pickup for this carrier''s labels (false for UPS by Worldwide Express).';

insert into public.shipping_carriers (shipstation_carrier_id, carrier, name, active, sort_order, notes, api_pickups)
values ('se-7177883', 'UPS', 'UPS by Worldwide Express', true, 2, 'CDS''s UPS account through Worldwide Express (contracted rates)', false)
on conflict (shipstation_carrier_id) do update
  set carrier = excluded.carrier,
      name = excluded.name,
      active = excluded.active,
      sort_order = excluded.sort_order,
      notes = excluded.notes,
      api_pickups = excluded.api_pickups,
      updated_at = now();

insert into public.shipping_services (carrier_id, service_code, name)
select c.id, s.code, s.name
  from public.shipping_carriers c
  cross join (values
    ('wwex_ups_ground', 'UPS Ground'),
    ('wwex_ups_3_day_select', 'UPS 3 Day Select'),
    ('wwex_ups_2nd_day_air', 'UPS 2nd Day Air'),
    ('wwex_ups_2nd_day_air_am', 'UPS 2nd Day Air A.M.'),
    ('wwex_ups_next_day_saver', 'UPS Next Day Air Saver'),
    ('wwex_ups_next_day_air', 'UPS Next Day Air'),
    ('wwex_ups_next_day_early', 'UPS Next Day Air Early')
  ) as s(code, name)
 where c.shipstation_carrier_id = 'se-7177883'
on conflict (carrier_id, service_code) do update
  set name = excluded.name;

