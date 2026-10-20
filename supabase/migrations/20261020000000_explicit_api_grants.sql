-- Explicit Data API grants for every table, view, sequence and function in public.
--
-- Why: on 2026-10-30 Supabase stops granting new objects in public to anon, authenticated
-- and service_role through default privileges (supabase.com/changelog/45329). Existing
-- objects keep their grants, but a fresh project or branch that replays these migrations
-- would end up with none, and every RPC granted only to authenticated would also lose
-- service_role's EXECUTE (it came from the default privileges). This migration writes the
-- grants staging has today, so the result no longer depends on default privileges.
--
-- Rule from now on: a migration that creates a public table, view, sequence or function
-- grants it explicitly in the same migration, and adds it to tests/rls/grants.snapshot.json.
-- The grants test fails on any object or privilege that is not in the snapshot.
--
-- Exact copy of staging on 2026-10-20 (Postgres 17, so MAINTAIN is included), except:
--  * anon loses USAGE, SELECT, UPDATE on audit_log_id_seq, integration_sync_id_seq,
--    shipment_tracking_events_id_seq and work_order_events_id_seq. They were left from before
--    core_schema revoked anon's default privileges; anon has no table access, so nothing
--    legitimate uses them (it could only burn ids with nextval).
--  * public.api_grants_matrix() is new: the grants test reads the live privileges through it.
--
-- Each object is revoked from PUBLIC, anon, authenticated and service_role first and then
-- granted, so running this again gives the same result.


-- Tables (41)

revoke all on table public.affiliate_contacts from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.affiliate_contacts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.affiliate_contacts to service_role;
revoke all on table public.affiliate_internal from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.affiliate_internal to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.affiliate_internal to service_role;
revoke all on table public.affiliates from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.affiliates to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.affiliates to service_role;
revoke all on table public.app_settings from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.app_settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.app_settings to service_role;
revoke all on table public.attachments from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.attachments to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.attachments to service_role;
revoke all on table public.audit_log from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.audit_log to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.audit_log to service_role;
revoke all on table public.authorization_decisions from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.authorization_decisions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.authorization_decisions to service_role;
revoke all on table public.authorization_requests from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.authorization_requests to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.authorization_requests to service_role;
revoke all on table public.catalog_items from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.catalog_items to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.catalog_items to service_role;
revoke all on table public.customer_billing from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.customer_billing to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_billing to service_role;
revoke all on table public.customer_email_domains from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.customer_email_domains to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_email_domains to service_role;
revoke all on table public.customer_item_aliases from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.customer_item_aliases to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_item_aliases to service_role;
revoke all on table public.customer_locations from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.customer_locations to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_locations to service_role;
revoke all on table public.customer_price_overrides from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.customer_price_overrides to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_price_overrides to service_role;
revoke all on table public.customers from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.customers to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customers to service_role;
revoke all on table public.inbound_emails from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.inbound_emails to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.inbound_emails to service_role;
revoke all on table public.integration_sync from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.integration_sync to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.integration_sync to service_role;
revoke all on table public.markets from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.markets to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.markets to service_role;
revoke all on table public.profiles from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.profiles to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.profiles to service_role;
revoke all on table public.qbo_customer_map from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.qbo_customer_map to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_customer_map to service_role;
revoke all on table public.qbo_item_map from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.qbo_item_map to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_item_map to service_role;
revoke all on table public.qbo_measurement_map from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.qbo_measurement_map to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_measurement_map to service_role;
revoke all on table public.sell_prices from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.sell_prices to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.sell_prices to service_role;
revoke all on table public.shipment_internal from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.shipment_internal to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipment_internal to service_role;
revoke all on table public.shipment_label_costs from public, anon, authenticated, service_role;
grant maintain, select on table public.shipment_label_costs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipment_label_costs to service_role;
revoke all on table public.shipment_label_tracking from public, anon, authenticated, service_role;
grant maintain, select on table public.shipment_label_tracking to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipment_label_tracking to service_role;
revoke all on table public.shipment_labels from public, anon, authenticated, service_role;
grant maintain, select on table public.shipment_labels to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipment_labels to service_role;
revoke all on table public.shipment_tracking_events from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.shipment_tracking_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipment_tracking_events to service_role;
revoke all on table public.shipments from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.shipments to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipments to service_role;
revoke all on table public.shipping_carriers from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.shipping_carriers to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipping_carriers to service_role;
revoke all on table public.shipping_services from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.shipping_services to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipping_services to service_role;
revoke all on table public.shipping_settings from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.shipping_settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipping_settings to service_role;
revoke all on table public.shipstation_webhook_events from public, anon, authenticated, service_role;
grant maintain, select on table public.shipstation_webhook_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shipstation_webhook_events to service_role;
revoke all on table public.shop_rates from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.shop_rates to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shop_rates to service_role;
revoke all on table public.tax_rates from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.tax_rates to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.tax_rates to service_role;
revoke all on table public.work_order_components from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.work_order_components to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_components to service_role;
revoke all on table public.work_order_events from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.work_order_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_events to service_role;
revoke all on table public.work_order_internal from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.work_order_internal to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_internal to service_role;
revoke all on table public.work_order_line_pricing from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.work_order_line_pricing to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_line_pricing to service_role;
revoke all on table public.work_order_lines from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.work_order_lines to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_lines to service_role;
revoke all on table public.work_orders from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.work_orders to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_orders to service_role;

-- Views (1)

revoke all on table public.work_order_financials from public, anon, authenticated, service_role;
grant maintain, select on table public.work_order_financials to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_financials to service_role;

-- Sequences (6)

revoke all on sequence public.audit_log_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.audit_log_id_seq to authenticated;
grant select, update, usage on sequence public.audit_log_id_seq to service_role;
revoke all on sequence public.integration_sync_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.integration_sync_id_seq to authenticated;
grant select, update, usage on sequence public.integration_sync_id_seq to service_role;
revoke all on sequence public.shipment_tracking_events_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.shipment_tracking_events_id_seq to authenticated;
grant select, update, usage on sequence public.shipment_tracking_events_id_seq to service_role;
revoke all on sequence public.shipstation_webhook_events_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.shipstation_webhook_events_id_seq to authenticated;
grant select, update, usage on sequence public.shipstation_webhook_events_id_seq to service_role;
revoke all on sequence public.wo_number_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.wo_number_seq to authenticated;
grant select, update, usage on sequence public.wo_number_seq to service_role;
revoke all on sequence public.work_order_events_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.work_order_events_id_seq to authenticated;
grant select, update, usage on sequence public.work_order_events_id_seq to service_role;

-- Functions (31)

revoke all on function public.cds_add_pass_through_line(uuid,uuid,text,numeric) from public, anon, authenticated, service_role;
grant execute on function public.cds_add_pass_through_line(uuid,uuid,text,numeric) to authenticated;
grant execute on function public.cds_add_pass_through_line(uuid,uuid,text,numeric) to service_role;
revoke all on function public.cds_create_work_order(uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cds_create_work_order(uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,jsonb) to authenticated;
grant execute on function public.cds_create_work_order(uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,jsonb) to service_role;
revoke all on function public.cds_decide_authorization(uuid,boolean,text,text) from public, anon, authenticated, service_role;
grant execute on function public.cds_decide_authorization(uuid,boolean,text,text) to authenticated;
grant execute on function public.cds_decide_authorization(uuid,boolean,text,text) to service_role;
revoke all on function public.cds_dispatch_work_order(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_dispatch_work_order(uuid,uuid) to authenticated;
grant execute on function public.cds_dispatch_work_order(uuid,uuid) to service_role;
revoke all on function public.cds_mark_invoiced(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.cds_mark_invoiced(uuid,text,text) to authenticated;
grant execute on function public.cds_mark_invoiced(uuid,text,text) to service_role;
revoke all on function public.cds_record_shipment_label(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cds_record_shipment_label(uuid,jsonb) to authenticated;
grant execute on function public.cds_record_shipment_label(uuid,jsonb) to service_role;
revoke all on function public.cds_remove_pass_through_line(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_remove_pass_through_line(uuid) to authenticated;
grant execute on function public.cds_remove_pass_through_line(uuid) to service_role;
revoke all on function public.cds_set_price(text,uuid,uuid,numeric) from public, anon, authenticated, service_role;
grant execute on function public.cds_set_price(text,uuid,uuid,numeric) to authenticated;
grant execute on function public.cds_set_price(text,uuid,uuid,numeric) to service_role;
revoke all on function public.cds_set_status(uuid,public.wo_status,text) from public, anon, authenticated, service_role;
grant execute on function public.cds_set_status(uuid,public.wo_status,text) to authenticated;
grant execute on function public.cds_set_status(uuid,public.wo_status,text) to service_role;
revoke all on function public.cds_void_shipment_label(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.cds_void_shipment_label(uuid,text) to authenticated;
grant execute on function public.cds_void_shipment_label(uuid,text) to service_role;
revoke all on function public.intake_create_draft_work_order(uuid,uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,text,jsonb,text,integer,date,boolean,text,text,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.intake_create_draft_work_order(uuid,uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,text,jsonb,text,integer,date,boolean,text,text,text,text,text) to authenticated;
grant execute on function public.intake_create_draft_work_order(uuid,uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,text,jsonb,text,integer,date,boolean,text,text,text,text,text) to service_role;
revoke all on function public.intake_note_po_reference(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.intake_note_po_reference(uuid,text) to authenticated;
grant execute on function public.intake_note_po_reference(uuid,text) to service_role;
revoke all on function public.qbo_connection_status() from public, anon, authenticated, service_role;
grant execute on function public.qbo_connection_status() to authenticated;
grant execute on function public.qbo_connection_status() to service_role;
revoke all on function public.qbo_delete_connection(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qbo_delete_connection(uuid) to service_role;
revoke all on function public.qbo_get_connection() from public, anon, authenticated, service_role;
grant execute on function public.qbo_get_connection() to service_role;
revoke all on function public.qbo_save_connection(text,text,text,boolean,text,timestamp with time zone,text,timestamp with time zone,uuid) from public, anon, authenticated, service_role;
grant execute on function public.qbo_save_connection(text,text,text,boolean,text,timestamp with time zone,text,timestamp with time zone,uuid) to service_role;
revoke all on function public.qbo_save_tokens(text,text,text,timestamp with time zone,text,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.qbo_save_tokens(text,text,text,timestamp with time zone,text,timestamp with time zone) to service_role;
revoke all on function public.shipstation_auto_deliver_sweep() from public, anon, authenticated, service_role;
grant execute on function public.shipstation_auto_deliver_sweep() to service_role;
revoke all on function public.shipstation_labels_to_track(integer) from public, anon, authenticated, service_role;
grant execute on function public.shipstation_labels_to_track(integer) to service_role;
revoke all on function public.shipstation_record_tracking(uuid,text,public.shipment_status,timestamp with time zone,timestamp with time zone,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.shipstation_record_tracking(uuid,text,public.shipment_status,timestamp with time zone,timestamp with time zone,jsonb,text) to service_role;
revoke all on function public.shipstation_record_webhook(text,text,text,text,public.shipment_status,timestamp with time zone,jsonb,jsonb,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.shipstation_record_webhook(text,text,text,text,public.shipment_status,timestamp with time zone,jsonb,jsonb,timestamp with time zone) to service_role;
revoke all on function public.shop_accept_work_order(uuid,public.pickup_window) from public, anon, authenticated, service_role;
grant execute on function public.shop_accept_work_order(uuid,public.pickup_window) to authenticated;
grant execute on function public.shop_accept_work_order(uuid,public.pickup_window) to service_role;
revoke all on function public.shop_add_part(uuid,uuid,numeric) from public, anon, authenticated, service_role;
grant execute on function public.shop_add_part(uuid,uuid,numeric) to authenticated;
grant execute on function public.shop_add_part(uuid,uuid,numeric) to service_role;
revoke all on function public.shop_complete_work_order(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.shop_complete_work_order(uuid,text) to authenticated;
grant execute on function public.shop_complete_work_order(uuid,text) to service_role;
revoke all on function public.shop_decline_work_order(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.shop_decline_work_order(uuid,text) to authenticated;
grant execute on function public.shop_decline_work_order(uuid,text) to service_role;
revoke all on function public.shop_delete_component(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.shop_delete_component(uuid,uuid) to authenticated;
grant execute on function public.shop_delete_component(uuid,uuid) to service_role;
revoke all on function public.shop_remove_part(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.shop_remove_part(uuid,uuid) to authenticated;
grant execute on function public.shop_remove_part(uuid,uuid) to service_role;
revoke all on function public.shop_request_authorization(uuid,uuid,numeric,text) from public, anon, authenticated, service_role;
grant execute on function public.shop_request_authorization(uuid,uuid,numeric,text) to authenticated;
grant execute on function public.shop_request_authorization(uuid,uuid,numeric,text) to service_role;
revoke all on function public.shop_save_component(uuid,uuid,public.component_type,text,text,text,numeric,numeric,numeric,numeric,public.component_result,text) from public, anon, authenticated, service_role;
grant execute on function public.shop_save_component(uuid,uuid,public.component_type,text,text,text,numeric,numeric,numeric,numeric,public.component_result,text) to authenticated;
grant execute on function public.shop_save_component(uuid,uuid,public.component_type,text,text,text,numeric,numeric,numeric,numeric,public.component_result,text) to service_role;
revoke all on function public.shop_set_progress(uuid,public.wo_status) from public, anon, authenticated, service_role;
grant execute on function public.shop_set_progress(uuid,public.wo_status) to authenticated;
grant execute on function public.shop_set_progress(uuid,public.wo_status) to service_role;
revoke all on function public.shop_set_ship_status(uuid,public.shop_ship_status) from public, anon, authenticated, service_role;
grant execute on function public.shop_set_ship_status(uuid,public.shop_ship_status) to authenticated;
grant execute on function public.shop_set_ship_status(uuid,public.shop_ship_status) to service_role;

-- The live privileges of PUBLIC, anon, authenticated and service_role on every table, view,
-- sequence and function in public (objects that belong to an extension are left out). A NULL
-- ACL means the owner's built-in defaults, so acldefault fills it in. Read by the grants test.
create function public.api_grants_matrix()
returns table (kind text, object text, grantee text, privileges text)
language sql stable security definer set search_path = '' as $$
  with objs as (
    select case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'view'
             else 'table' end as kind,
           format('%I.%I', n.nspname, c.relname) as object,
           coalesce(c.relacl, pg_catalog.acldefault(
             case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner)) as acl
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid
                        and d.deptype = 'e')
    union all
    select 'function', p.oid::regprocedure::text,
           coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid
                        and d.deptype = 'e')
  )
  select o.kind, o.object,
         case when a.grantee = 0 then 'PUBLIC' else r.rolname::text end,
         string_agg(a.privilege_type, ',' order by a.privilege_type)
  from objs o
  cross join lateral pg_catalog.aclexplode(o.acl) a
  left join pg_catalog.pg_roles r on r.oid = a.grantee
  where a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role')
  group by o.kind, o.object, 3
  order by o.kind, o.object, 3
$$;

revoke all on function public.api_grants_matrix() from public, anon, authenticated, service_role;
grant execute on function public.api_grants_matrix() to service_role;
