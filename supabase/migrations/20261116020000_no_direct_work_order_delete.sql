-- A work order is deleted only through public.cds_delete_work_order.
--
-- 20261020000000_explicit_api_grants.sql granted DELETE on public.work_orders to
-- authenticated, and policy cds_all lets every CDS login delete any order with a plain DELETE
-- through the Data API. That skipped the checks in cds_delete_work_order
-- (20261111060000_delete_work_order_permission.sql): only a login with
-- can_delete_work_orders, no real label in use, the change log entry, and the email and
-- QuickBooks cleanup.
--
-- The app never deletes work orders directly with the user's client. cds_delete_work_order is
-- security definer (runs as the owner) and is not affected; neither are deletes made with the
-- service role (fixtures) or cascades from other tables.

revoke delete on table public.work_orders from authenticated;
