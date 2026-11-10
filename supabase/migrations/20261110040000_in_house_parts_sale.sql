-- In-house parts sales complete without components (2026-11-10).
--
-- Why: a work order of CDS's in-house shop with request_type 'parts_only' is a plain parts
-- sale (CDS sells the part itself; nothing is cleaned). Completing it must not ask for a
-- component, its measurements or a failed-part photo.
--
-- public.shop_complete_work_order: same as 20261110030000_in_house_shop.sql, except that the
-- component checks are skipped when the order is 'parts_only' AND its shop is the in-house
-- shop. Every other order keeps the component rules exactly: service orders at the in-house
-- shop, and 'parts_only' orders at outside shops. Pending extra work requests still block
-- completion; the IN-HOUSE-<wo number> reference rule is unchanged. Grants are unchanged.

-- Same as 20261110030000, plus: no component checks for an in-house parts sale.
create or replace function public.shop_complete_work_order(p_work_order uuid, p_invoice_ref text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  c record;
  label text;
  ref text := btrim(coalesce(p_invoice_ref, ''));
  parts_sale boolean;
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
    if c.component_type in ('DPF', 'DOC') and (
         c.dp_before is null or c.dp_after is null or c.weight_before_g is null or c.weight_after_g is null) then
      raise exception '%: pressure before and after, and weight before and after (grams) are required', label
        using errcode = 'P0001';
    end if;
    if c.result in ('failed', 'condemned') and not exists (
         select 1 from public.attachments a where a.component_id = c.id) then
      raise exception '%: add a photo for a failed or condemned part', label using errcode = 'P0001';
    end if;
  end loop;

  if exists (
    select 1 from public.authorization_requests
    where work_order_id = wo.id and status = 'pending'
      and (affiliate_id = wo.affiliate_id or affiliate_id is null)
  ) then
    raise exception 'An extra work request is still waiting for CDS' using errcode = 'P0001';
  end if;

  update public.work_orders
     set status = 'completed', completed_at = now(), affiliate_invoice_ref = ref,
         shop_ship_status = case when fulfillment = 'shipping' then 'ready_to_ship' else shop_ship_status end
   where id = wo.id;
  perform private.log_event(wo.id, 'complete', wo.status, 'completed', 'Completed by shop', true);
end $$;
