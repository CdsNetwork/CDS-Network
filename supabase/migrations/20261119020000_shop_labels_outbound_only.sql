-- Shops see and print only the label of the leg back to the customer (Sarah, CDS, 2026-11-17).
--
-- Before: the shipment_labels shop_read policy (20261018000000_shipstation.sql) showed a shop
-- every label on its own work orders, also the label of the inbound leg (customer to shop),
-- which the customer prints, not the shop.
--
-- Now a shop reads a label only when its shipment goes from the shop to the customer
-- (direction affiliate_to_customer). The shipments rows are unchanged, so the shop still sees
-- every leg with its tracking number and status. The label PDF route
-- (src/app/api/shipstation/label/[id]/route.ts) reads the label with the caller's client, so
-- an inbound label answers "Not found" to a shop. CDS still reads every label (cds_read).
-- Grants (20261020000000_explicit_api_grants.sql) restated unchanged.

drop policy shop_read on public.shipment_labels;

create policy shop_read on public.shipment_labels for select to authenticated
  using (
    private.shop_can_see_wo(work_order_id)
    and exists (
      select 1 from public.shipments s
       where s.id = shipment_labels.shipment_id
         and s.direction = 'affiliate_to_customer')
  );

revoke all on table public.shipment_labels from public, anon, authenticated, service_role;
grant maintain, select on table public.shipment_labels to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipment_labels to service_role;
