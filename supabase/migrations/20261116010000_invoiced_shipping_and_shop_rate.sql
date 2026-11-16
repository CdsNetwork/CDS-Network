-- An order invoiced before it is shipped.
--
-- CDS may create the customer invoice at any time (20261112040000_invoice_any_time.sql). When
-- the order has a QuickBooks invoice before the shop completes it, completion moves it
-- straight to Invoiced with the shipping status Ready to Ship; a completed order CDS invoices
-- before the shop ships it is Invoiced too. Two steps that come after completion were then
-- refused because the order is Invoiced:
--
-- 1. public.shop_set_ship_status: the shop could not mark the part Shipped. It now also
--    accepts an Invoiced shipping job the shop completed (completed_at is set). A cancelled
--    order, an order the shop never completed and a pickup job stay refused. Otherwise as in
--    20261014000000_work_order_flow.sql.
-- 2. public.cds_set_line_shop_rate: a shop rate that was TBD (it often comes with the shop's
--    invoice) could not be entered, so the shop cost stayed TBD for good. On an Invoiced order
--    CDS may now enter a TBD rate once; a rate already set does not change. Shop rates are shop
--    pay, not on the customer invoice (20261112040000). A cancelled order stays refused.
--    Otherwise as in 20261111090000_customer_items_and_line_prices.sql.
--
-- Grants are unchanged (create or replace keeps them); restated as in
-- 20261020000000_explicit_api_grants.sql.

create or replace function public.shop_set_ship_status(p_work_order uuid, p_status public.shop_ship_status)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  if wo.fulfillment <> 'shipping'
     or not (wo.status in ('accepted', 'in_process', 'completed')
             or (wo.status = 'invoiced' and wo.completed_at is not null)) then
    raise exception 'Shipping status applies to accepted shipping jobs' using errcode = 'P0001';
  end if;
  update public.work_orders
     set shop_ship_status = p_status,
         status = case when p_status = 'in_process' and status = 'accepted' then 'in_process' else status end
   where id = wo.id;
  perform private.log_event(wo.id, 'ship_status', null, null, 'Shop shipping status: ' || p_status::text, true);
end $$;

revoke all on function public.shop_set_ship_status(uuid, public.shop_ship_status) from public, anon, authenticated, service_role;
grant execute on function public.shop_set_ship_status(uuid, public.shop_ship_status) to authenticated;
grant execute on function public.shop_set_ship_status(uuid, public.shop_ship_status) to service_role;

create or replace function public.cds_set_line_shop_rate(p_line uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  ln record;
begin
  perform private.require_cds();
  if p_amount is null or p_amount < 0 or p_amount > 99999.99 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter the shop rate in dollars and cents' using errcode = 'P0001';
  end if;
  select l.id, l.work_order_id, l.shop_unit_rate, l.shop_rate_source, c.name, c.price_per_line, c.pass_through
    into ln
    from public.work_order_lines l join public.catalog_items c on c.id = l.catalog_item_id
   where l.id = p_line
     for update of l;
  if not found then
    raise exception 'Line not found' using errcode = 'P0002';
  end if;
  if ln.price_per_line and ln.pass_through then
    raise exception 'The shop is paid the amount on its invoice for this item: remove the line and add it again'
      using errcode = 'P0001';
  end if;
  if ln.shop_unit_rate is not null and ln.shop_rate_source <> 'manual' then
    raise exception 'This line has the shop rate from the price list' using errcode = 'P0001';
  end if;
  select * into wo from public.work_orders w where w.id = ln.work_order_id for update;
  if wo.status = 'cancelled' then
    raise exception 'Lines cannot change once the work order is invoiced or cancelled' using errcode = 'P0001';
  end if;
  if wo.status = 'invoiced' and ln.shop_unit_rate is not null then
    raise exception 'The shop rate cannot change once the work order is invoiced' using errcode = 'P0001';
  end if;

  perform set_config('cds.resnapshot', 'on', true);
  update public.work_order_lines set shop_unit_rate = p_amount, shop_rate_source = 'manual' where id = ln.id;
  perform set_config('cds.resnapshot', '', true);
  perform private.log_event(wo.id, 'line_rate_set', null, null,
    'CDS set the shop rate for ' || ln.name || ': $' || to_char(p_amount, 'FM999990.00'),
    wo.status not in ('pending_review', 'rejected_by_affiliate'));
end $$;

revoke all on function public.cds_set_line_shop_rate(uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.cds_set_line_shop_rate(uuid, numeric) to authenticated;
grant execute on function public.cds_set_line_shop_rate(uuid, numeric) to service_role;
