-- Condemned EGR cooler needs no photo; DOC measurements are optional (Sarah, CDS, 2026-11-17).
--
-- public.shop_complete_work_order: the same as in 20261112050000_condemned_replaces_failed.sql,
-- with two changes only:
--   1. Pressure before and after and weight before and after are required for a DPF that is
--      not condemned only. A DOC no longer needs them (an SCR never did; an EGR cooler has
--      none).
--   2. The photo of a condemned component is not required for an EGR cooler. A condemned DPF,
--      DOC or SCR still needs one.
-- The shop's component card (src/components/shop/types.ts measurementsRequired and
-- condemnedPhotoRequired) follows the same rules.
-- Grants (20261020000000_explicit_api_grants.sql) restated unchanged.

create or replace function public.shop_complete_work_order(p_work_order uuid, p_invoice_ref text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  c record;
  label text;
  ref text := btrim(coalesce(p_invoice_ref, ''));
  parts_sale boolean;
  invoice text;
begin
  perform private.shop_can_edit(wo);
  if ref = '' and private.is_in_house_shop(wo.affiliate_id) then
    ref := coalesce(nullif(btrim(wo.affiliate_invoice_ref), ''), 'IN-HOUSE-' || wo.wo_number);
  end if;
  if ref = '' then
    raise exception 'Enter your invoice or reference number' using errcode = 'P0001';
  end if;
  perform private.check_length(ref, 100);
  -- A parts sale by CDS itself: no component, measurement or photo to record.
  parts_sale := wo.request_type = 'parts_only' and private.is_in_house_shop(wo.affiliate_id);
  if not parts_sale and not exists (
    select 1 from public.work_order_components
    where work_order_id = wo.id and (affiliate_id = wo.affiliate_id or affiliate_id is null)
  ) then
    raise exception 'Add at least one component' using errcode = 'P0001';
  end if;

  for c in select * from public.work_order_components
            where not parts_sale
              and work_order_id = wo.id and (affiliate_id = wo.affiliate_id or affiliate_id is null)
            order by seq loop
    label := c.component_type::text || ' #' || c.seq;
    if c.manufacturer is null or c.part_number is null or c.serial_number is null then
      raise exception '%: manufacturer, part number and serial number are required', label using errcode = 'P0001';
    end if;
    if c.result is null then
      raise exception '%: choose a result', label using errcode = 'P0001';
    end if;
    if c.component_type = 'DPF' and c.result <> 'condemned' and (
         c.dp_before is null or c.dp_after is null or c.weight_before_g is null or c.weight_after_g is null) then
      raise exception '%: pressure before and after, and weight before and after (grams) are required', label
        using errcode = 'P0001';
    end if;
    if c.result = 'condemned' and c.component_type <> 'EGR' and not exists (
         select 1 from public.attachments a where a.component_id = c.id) then
      raise exception '%: add a photo for a condemned part', label using errcode = 'P0001';
    end if;
  end loop;

  if exists (
    select 1 from public.authorization_requests
    where work_order_id = wo.id and status = 'pending'
      and (affiliate_id = wo.affiliate_id or affiliate_id is null)
  ) then
    raise exception 'An extra work request is still waiting for CDS' using errcode = 'P0001';
  end if;

  -- CDS created the customer invoice before the shop finished: the order is done and billed.
  select coalesce(i.qb_invoice_number, 'id ' || i.qb_invoice_id) into invoice
    from public.work_order_internal i
   where i.work_order_id = wo.id and i.qb_invoice_id is not null
     for update;

  update public.work_orders
     set status = case when invoice is null then 'completed'::public.wo_status else 'invoiced'::public.wo_status end,
         completed_at = now(), affiliate_invoice_ref = ref,
         shop_ship_status = case when fulfillment = 'shipping' then 'ready_to_ship' else shop_ship_status end
   where id = wo.id;
  perform private.log_event(wo.id, 'complete', wo.status, 'completed', 'Completed by shop', true);
  if invoice is not null then
    perform private.log_event(wo.id, 'invoice', 'completed', 'invoiced',
      'Moved to Invoiced: QuickBooks invoice ' || invoice || ' was created before the shop completed the job', false);
  end if;
end $$;

revoke all on function public.shop_complete_work_order(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.shop_complete_work_order(uuid, text) to authenticated;
grant execute on function public.shop_complete_work_order(uuid, text) to service_role;
