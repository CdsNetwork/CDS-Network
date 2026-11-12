-- "Condemned" replaces "Failed" (Sarah, CDS, 2026-11-12: "failed" and "condemned" essentially
-- mean the same thing for CDS; only "condemned" is used from now on).
--
-- 1. work_order_components and component_failures rows with result 'failed' become
--    'condemned'. Their result_note is kept (a failed result already needed one, as condemned
--    does). The component triggers are off during the update, so it neither flags the orders
--    "New from shop" nor records new failures nor changes updated_at.
-- 2. The result checks no longer accept 'failed': a DPF, DOC or SCR is cleaned or condemned,
--    an EGR cooler is passed or condemned (no measurements, as before). The enum value
--    'failed' stays in public.component_result (it cannot be dropped easily); no row can hold
--    it. work_order_components_check2 (a condemned result needs a reason) is unchanged.
-- 3. private.shop_failure_activity records a failure and flags the order for 'condemned' only.
--    The activity kind stays 'failed' (an internal value; the list shows "Condemned").
-- 4. public.shop_complete_work_order: same as 20261112040000_invoice_any_time.sql, except that
--    the photo check is for a condemned component only.
-- Grants are unchanged.

-- ---------------------------------------------------------------- 1. existing rows

alter table public.work_order_components disable trigger shop_activity;
alter table public.work_order_components disable trigger touch;
update public.work_order_components set result = 'condemned' where result = 'failed';
alter table public.work_order_components enable trigger shop_activity;
alter table public.work_order_components enable trigger touch;

update public.component_failures set result = 'condemned' where result = 'failed';

-- ---------------------------------------------------------------- 2. checks

alter table public.work_order_components
  drop constraint work_order_components_check,
  drop constraint work_order_components_check1,
  add constraint work_order_components_egr_check check (
    component_type <> 'EGR'
    or (dp_before is null and dp_after is null and weight_before_g is null and weight_after_g is null
        and (result is null or result in ('passed', 'condemned')))
  ),
  add constraint work_order_components_result_check check (
    component_type = 'EGR' or result is null or result in ('cleaned', 'condemned')
  );

alter table public.component_failures
  drop constraint component_failures_result_check,
  add constraint component_failures_result_check check (result = 'condemned');

-- ---------------------------------------------------------------- 3. failure activity

create or replace function private.shop_failure_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.result = 'condemned'
     and (tg_op = 'INSERT' or old.result is distinct from new.result)
     and private.is_shop_login(new.updated_by) then
    insert into public.component_failures
      (work_order_id, component_id, affiliate_id, component_type, manufacturer, part_number, serial_number,
       result, result_note, failed_by)
    values
      (new.work_order_id, new.id, new.affiliate_id, new.component_type, new.manufacturer, new.part_number,
       new.serial_number, new.result, new.result_note, new.updated_by);
    perform private.record_shop_activity(new.work_order_id, 'failed');
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- 4. completion

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
    if c.component_type in ('DPF', 'DOC') and c.result <> 'condemned' and (
         c.dp_before is null or c.dp_after is null or c.weight_before_g is null or c.weight_after_g is null) then
      raise exception '%: pressure before and after, and weight before and after (grams) are required', label
        using errcode = 'P0001';
    end if;
    if c.result = 'condemned' and not exists (
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
