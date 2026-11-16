-- Reserve a label purchase or a pickup booking before ShipStation is called.
--
-- src/lib/shipstation/labels.ts and pickups.ts checked for an existing label or pickup, called
-- ShipStation, and only then recorded the result (cds_record_shipment_label,
-- cds_record_shipment_pickup). Two requests at the same time (a double click, two people on
-- the same order) both passed the check and both bought a label or booked a pickup; only one
-- was recorded.
--
-- private.shipstation_claims holds one live claim per operation: kind 'label' for a shipment
-- (target = shipments.id), kind 'pickup' for a label (target = shipment_labels.id).
--
-- public.cds_claim_shipstation(kind, target) (CDS only) locks the shipment or label, refuses
-- when it already has an active label or a scheduled pickup, and takes the claim. While
-- another claim is live it is refused ("A label is already being created for this shipment.
-- Refresh in a moment."). A claim older than 5 minutes has expired (the app gave up or
-- crashed) and is taken over, so a shipment is never locked for good. Returns the claim id;
-- the app uses it in the label's external shipment id.
--
-- public.cds_release_shipstation(kind, target, claim) (CDS only) drops that claim once the
-- result is recorded or ShipStation clearly refused. When ShipStation did not answer clearly
-- the app keeps the claim until it expires, so a quick retry cannot buy a second label.

create table private.shipstation_claims (
  kind text not null check (kind in ('label', 'pickup')),
  target uuid not null,
  claim_id uuid not null default gen_random_uuid(),
  claimed_by uuid references public.profiles on delete set null,
  claimed_at timestamptz not null default now(),
  primary key (kind, target)
);

alter table private.shipstation_claims enable row level security;
revoke all on private.shipstation_claims from public, anon, authenticated;
grant select, insert, update, delete on private.shipstation_claims to service_role;

create function public.cds_claim_shipstation(p_kind text, p_target uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  claim uuid;
  label_status text;
begin
  perform private.require_cds();
  if p_kind = 'label' then
    perform 1 from public.shipments where id = p_target for update;
    if not found then
      raise exception 'Shipment not found' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.shipment_labels l where l.shipment_id = p_target and l.status = 'active') then
      raise exception 'This shipment already has a label. Void it before creating another.' using errcode = 'P0001';
    end if;
  elsif p_kind = 'pickup' then
    select l.status::text into label_status from public.shipment_labels l where l.id = p_target for update;
    if not found then
      raise exception 'Label not found' using errcode = 'P0002';
    end if;
    if label_status <> 'active' then
      raise exception 'This label is voided.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.shipment_pickups p where p.label_id = p_target and p.status = 'scheduled') then
      raise exception 'This label already has a pickup. Cancel it before booking another.' using errcode = 'P0001';
    end if;
  else
    raise exception 'Unknown ShipStation operation %', p_kind using errcode = 'P0001';
  end if;

  -- Claims of shipments and labels deleted since are left behind; drop old ones.
  delete from private.shipstation_claims c where c.claimed_at < now() - interval '1 day';

  insert into private.shipstation_claims as c (kind, target, claimed_by)
  values (p_kind, p_target, auth.uid())
  on conflict (kind, target) do update
     set claim_id = gen_random_uuid(), claimed_by = excluded.claimed_by, claimed_at = now()
   where c.claimed_at < now() - interval '5 minutes'
  returning c.claim_id into claim;

  if claim is null then
    if p_kind = 'label' then
      raise exception 'A label is already being created for this shipment. Refresh in a moment.' using errcode = 'P0001';
    end if;
    raise exception 'A pickup is already being booked for this label. Refresh in a moment.' using errcode = 'P0001';
  end if;
  return claim;
end $$;

create function public.cds_release_shipstation(p_kind text, p_target uuid, p_claim uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_cds();
  delete from private.shipstation_claims c
   where c.kind = p_kind and c.target = p_target and c.claim_id = p_claim;
end $$;

revoke all on function public.cds_claim_shipstation(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_claim_shipstation(text, uuid) to authenticated;
grant execute on function public.cds_claim_shipstation(text, uuid) to service_role;
revoke all on function public.cds_release_shipstation(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_release_shipstation(text, uuid, uuid) to authenticated;
grant execute on function public.cds_release_shipstation(text, uuid, uuid) to service_role;
