-- Fulfillment method after dispatch (Sarah, CDS, 2026-11-24): CDS changes an order from
-- shipping to shop pickup (or back) after it was sent to the shop, until the order is invoiced.
-- Until now only the Edit order box in review changed it, so a wrong method needed a decline
-- and a new dispatch.
--
-- 1. public.cds_set_fulfillment(order, method) (CDS only), 'shipping' or 'pickup':
--      * after dispatch only (in review the Edit order box saves it with the other fields),
--        not on a cancelled order;
--      * not once the order is invoiced or has its QuickBooks invoice (private.wo_invoiced:
--        the method gives the customer shipping charge on the invoice); while the invoice is
--        being created the existing lock refuses it (private.invoice_inputs_locked lists
--        fulfillment since 20261119120000_customer_shipping_charge.sql);
--      * not once the shop's bill is in QuickBooks (private.wo_has_shop_bill), nor while it
--        is being created (a live 'creating' claim): the method decides the shop's shipping
--        deduction on that bill (public.work_order_shop_deductions). Same rule as the shipping
--        credit (private.shop_shipping_credit_locked). A CDS approval of a bill not yet sent
--        is cleared (private.clear_shop_bill_approval): CDS approves the bill again;
--      * to pickup: refused while the order has a purchased label that is not voided
--        (shipment_labels status 'active') or a label is being bought (a live ShipStation
--        claim): CDS voids the label first. Shipment legs without a label stay (CDS removes
--        them in Logistics if they are not needed). An order the shop already accepted gets
--        the pickup window 'coordinate' (Need to coordinate) when it has none, as the table
--        requires a window on an accepted pickup job; the shop then sets the day and window
--        (public.shop_set_pickup) while the job is accepted. Before acceptance the shop
--        chooses them when it accepts, as for any pickup job;
--      * to shipping: the pickup day and window are cleared; the shop's shipping status
--        starts as on an accepted shipping job (Awaiting delivery, or Ready to ship once the
--        shop completed the job) unless it already has one;
--      * logged on the order's history with the old and new method (CDS only, like the unit
--        and location changes). The shop sees the new method on its job; no email is sent
--        (the shop emails follow status and shop changes only).
-- 2. After dispatch a signed-in user changes work_orders.fulfillment only through that
--    function: a direct update is refused (private.fulfillment_after_dispatch_guard). In review
--    the Edit order box still updates it directly. The service role and the database owner
--    (fixtures, maintenance) are not affected. The trigger name sorts after
--    invoice_inputs_locked, so an order whose invoice is being created still says so first.
-- Grants: cds_set_fulfillment to authenticated and service_role (tests/rls/grants.snapshot.json).

-- ---------------------------------------------------------------- 1. change

-- The names on the work order page (src/lib/format.ts FULFILLMENT_LABEL).
create function private.fulfillment_label(p public.fulfillment_method) returns text
language sql immutable set search_path = '' as $$
  select case p
    when 'pickup' then 'Affiliate Pickup / Local Delivery'
    when 'shipping' then 'Shipping / Carrier'
    when 'supplier_direct' then 'Supplier Direct Ship'
    else 'Not set'
  end
$$;
revoke all on function private.fulfillment_label(public.fulfillment_method) from public;

create function public.cds_set_fulfillment(p_work_order uuid, p_fulfillment public.fulfillment_method)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
begin
  perform private.require_cds();
  if p_fulfillment is null or p_fulfillment not in ('shipping', 'pickup') then
    raise exception 'Choose shipping or shop pickup.' using errcode = 'P0001';
  end if;
  select * into wo from public.work_orders w where w.id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status in ('pending_review', 'rejected_by_affiliate') then
    raise exception 'Change the fulfillment in the Edit order box while the order is in review.' using errcode = 'P0001';
  end if;
  if wo.status = 'cancelled' then
    raise exception 'The fulfillment of a cancelled order cannot change.' using errcode = 'P0001';
  end if;
  if private.wo_invoiced(wo.id) then
    raise exception 'The fulfillment cannot change once the order is invoiced in QuickBooks.' using errcode = 'P0001';
  end if;
  if private.wo_has_shop_bill(wo.id) then
    raise exception 'The fulfillment cannot change: the shop''s bill is in QuickBooks.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.qbo_shop_bills b
     where b.work_order_id = wo.id and b.status = 'creating' and b.claimed_at > now() - interval '5 minutes'
  ) then
    raise exception 'The fulfillment cannot change while the shop''s bill is being created. Refresh in a moment.' using errcode = 'P0001';
  end if;
  if wo.fulfillment = p_fulfillment then
    return;
  end if;

  if p_fulfillment = 'pickup' then
    if exists (select 1 from public.shipment_labels l where l.work_order_id = wo.id and l.status = 'active') then
      raise exception 'This order has a shipping label. Void the label in Logistics first, then change the fulfillment to shop pickup.'
        using errcode = 'P0001';
    end if;
    if exists (
      select 1 from private.shipstation_claims c
        join public.shipments s on s.id = c.target
       where c.kind = 'label' and s.work_order_id = wo.id and c.claimed_at > now() - interval '5 minutes'
    ) then
      raise exception 'A shipping label is being created for this order. Refresh in a moment.' using errcode = 'P0001';
    end if;
    update public.work_orders w
       set fulfillment = 'pickup',
           pickup_window = case when w.status = 'awaiting_acceptance' then w.pickup_window
                                else coalesce(w.pickup_window, 'coordinate') end
     where w.id = wo.id;
  else
    update public.work_orders w
       set fulfillment = 'shipping',
           pickup_window = null,
           pickup_date = null,
           shop_ship_status = coalesce(w.shop_ship_status, case
             when w.status = 'awaiting_acceptance' then null
             when w.completed_at is not null then 'ready_to_ship'::public.shop_ship_status
             else 'awaiting_delivery'::public.shop_ship_status end)
     where w.id = wo.id;
  end if;

  perform private.clear_shop_bill_approval(wo.id);
  perform private.log_event(wo.id, 'edit', null, null,
    'Fulfillment changed by CDS: ' || private.fulfillment_label(wo.fulfillment) || ' to ' || private.fulfillment_label(p_fulfillment),
    false);
end $$;

revoke all on function public.cds_set_fulfillment(uuid, public.fulfillment_method) from public, anon, authenticated, service_role;
grant execute on function public.cds_set_fulfillment(uuid, public.fulfillment_method) to authenticated;
grant execute on function public.cds_set_fulfillment(uuid, public.fulfillment_method) to service_role;

-- ---------------------------------------------------------------- 2. only through the function

create function private.fulfillment_after_dispatch_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Inside public.cds_set_fulfillment current_user is its owner, not 'authenticated'.
  if current_user = 'authenticated'
     and new.fulfillment is distinct from old.fulfillment
     and old.status not in ('pending_review', 'rejected_by_affiliate') then
    raise exception 'After dispatch the fulfillment changes with Edit fulfillment on the work order.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.fulfillment_after_dispatch_guard() from public;

create trigger work_orders_fulfillment_after_dispatch
  before update of fulfillment on public.work_orders
  for each row execute function private.fulfillment_after_dispatch_guard();
