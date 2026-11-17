-- "Tomorrow" pickup ETA (Sarah, CDS, 2026-11-17).
--
-- A shop accepting a pickup job picks its pickup ETA / window from a list
-- (src/lib/format.ts PICKUP_WINDOWS). The list gains "Tomorrow", for a shop that picks the
-- part up the next day without a time window yet. work_orders.pickup_window is the enum
-- public.pickup_window, so the value is added here. Nothing else checks the value:
-- shop_accept_work_order takes the enum, and the Pickup board counts any window but
-- "coordinate" as committed.
-- Grants: no new object; public.shop_accept_work_order(uuid, public.pickup_window) keeps its
-- grants (restated below unchanged).

alter type public.pickup_window add value if not exists 'tomorrow' after '16-17';

revoke all on function public.shop_accept_work_order(uuid, public.pickup_window) from public, anon, authenticated, service_role;
grant execute on function public.shop_accept_work_order(uuid, public.pickup_window) to authenticated;
grant execute on function public.shop_accept_work_order(uuid, public.pickup_window) to service_role;
