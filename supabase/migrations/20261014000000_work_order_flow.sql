-- Work order flow: every status change and every shop write goes through these
-- functions. They run as the table owner, so each one checks who is calling first.
-- Shops still have no direct write access to any table.

create function private.log_event(
  wo uuid, kind text, from_s public.wo_status, to_s public.wo_status, msg text, visible boolean
) returns void language sql security definer set search_path = '' as $$
  insert into public.work_order_events (work_order_id, actor_id, event_type, from_status, to_status, message, shop_visible)
  values (wo, auth.uid(), kind, from_s, to_s, msg, visible)
$$;

-- Locks and returns the caller's own work order, or raises.
create function private.my_work_order(wo uuid) returns public.work_orders
language plpgsql security definer set search_path = '' as $$
declare
  row public.work_orders;
begin
  select * into row from public.work_orders w
  where w.id = wo and w.affiliate_id = private.my_affiliate()
    and w.status not in ('pending_review', 'rejected_by_affiliate')
  for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  return row;
end $$;

create function private.require_cds() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_cds() then
    raise exception 'Only CDS staff can do this' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------- shop actions

create function public.shop_accept_work_order(p_work_order uuid, p_pickup_window public.pickup_window default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  if wo.status <> 'awaiting_acceptance' then
    raise exception 'This job is not waiting for acceptance' using errcode = 'P0001';
  end if;
  if wo.fulfillment = 'pickup' and p_pickup_window is null then
    raise exception 'Choose a pickup window to accept a pickup job' using errcode = 'P0001';
  end if;
  update public.work_orders
     set status = 'accepted', accepted_at = now(), pickup_window = coalesce(p_pickup_window, pickup_window),
         shop_ship_status = case when fulfillment = 'shipping' then 'awaiting_delivery' else shop_ship_status end
   where id = wo.id;
  perform private.log_event(wo.id, 'accept', wo.status, 'accepted', 'Accepted by shop', true);
end $$;

-- A shop may turn a job down before it starts work (Clyde, 2026-10-14). The job goes back
-- to CDS flagged for attention, and the shop no longer sees it.
create function public.shop_decline_work_order(p_work_order uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  shop_name text;
begin
  if wo.status not in ('awaiting_acceptance', 'accepted') then
    raise exception 'Only a job that is not started yet can be declined' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Tell CDS why you are declining this job' using errcode = 'P0001';
  end if;
  select display_name into shop_name from public.affiliates where id = wo.affiliate_id;
  update public.work_orders set status = 'rejected_by_affiliate', pickup_window = null where id = wo.id;
  update public.work_order_internal
     set review_reason = 'Declined by ' || shop_name || ': ' || btrim(p_reason)
   where work_order_id = wo.id;
  perform private.log_event(wo.id, 'decline', wo.status, 'rejected_by_affiliate',
    'Declined by ' || shop_name || ': ' || btrim(p_reason), false);
end $$;

-- Picked Up (pickup jobs) and In Process.
create function public.shop_set_progress(p_work_order uuid, p_status public.wo_status)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  if p_status = 'picked_up' then
    if wo.fulfillment <> 'pickup' or wo.status <> 'accepted' then
      raise exception 'Only an accepted pickup job can be marked picked up' using errcode = 'P0001';
    end if;
    update public.work_orders set status = 'picked_up', picked_up_at = now() where id = wo.id;
  elsif p_status = 'in_process' then
    if wo.status not in ('accepted', 'picked_up') then
      raise exception 'Only an accepted job can move to In Process' using errcode = 'P0001';
    end if;
    update public.work_orders set status = 'in_process' where id = wo.id;
  else
    raise exception 'Shops can only set Picked Up or In Process' using errcode = 'P0001';
  end if;
  perform private.log_event(wo.id, 'status_change', wo.status, p_status,
    case p_status when 'picked_up' then 'Shop marked the part picked up' else 'Shop started work' end, true);
end $$;

create function public.shop_set_ship_status(p_work_order uuid, p_status public.shop_ship_status)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  if wo.fulfillment <> 'shipping' or wo.status not in ('accepted', 'in_process', 'completed') then
    raise exception 'Shipping status applies to accepted shipping jobs' using errcode = 'P0001';
  end if;
  update public.work_orders
     set shop_ship_status = p_status,
         status = case when p_status = 'in_process' and status = 'accepted' then 'in_process' else status end
   where id = wo.id;
  perform private.log_event(wo.id, 'ship_status', null, null, 'Shop shipping status: ' || p_status::text, true);
end $$;

create function private.shop_can_edit(wo public.work_orders) returns void
language plpgsql set search_path = '' as $$
begin
  if wo.status not in ('accepted', 'picked_up', 'in_process') then
    raise exception 'This job can no longer be edited' using errcode = 'P0001';
  end if;
end $$;

create function public.shop_save_component(
  p_work_order uuid,
  p_component uuid,
  p_type public.component_type,
  p_manufacturer text,
  p_part_number text,
  p_serial_number text,
  p_dp_before numeric,
  p_dp_after numeric,
  p_weight_before_g numeric,
  p_weight_after_g numeric,
  p_result public.component_result,
  p_result_note text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  saved uuid;
begin
  perform private.shop_can_edit(wo);
  if p_component is null then
    insert into public.work_order_components
      (work_order_id, seq, component_type, manufacturer, part_number, serial_number,
       dp_before, dp_after, weight_before_g, weight_after_g, result, result_note, updated_by)
    values
      (wo.id, coalesce((select max(seq) from public.work_order_components where work_order_id = wo.id), 0) + 1,
       p_type, nullif(btrim(p_manufacturer), ''), nullif(btrim(p_part_number), ''), nullif(btrim(p_serial_number), ''),
       p_dp_before, p_dp_after, p_weight_before_g, p_weight_after_g, p_result, nullif(btrim(p_result_note), ''),
       auth.uid())
    returning id into saved;
  else
    update public.work_order_components
       set component_type = p_type, manufacturer = nullif(btrim(p_manufacturer), ''),
           part_number = nullif(btrim(p_part_number), ''), serial_number = nullif(btrim(p_serial_number), ''),
           dp_before = p_dp_before, dp_after = p_dp_after,
           weight_before_g = p_weight_before_g, weight_after_g = p_weight_after_g,
           result = p_result, result_note = nullif(btrim(p_result_note), ''), updated_by = auth.uid()
     where id = p_component and work_order_id = wo.id
    returning id into saved;
    if saved is null then
      raise exception 'Component not found' using errcode = 'P0002';
    end if;
  end if;
  return saved;
end $$;

create function public.shop_delete_component(p_work_order uuid, p_component uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  perform private.shop_can_edit(wo);
  delete from public.work_order_components where id = p_component and work_order_id = wo.id;
end $$;

-- Parts used, from the catalog only. Services need an extra-work request instead.
create function public.shop_add_part(p_work_order uuid, p_catalog_item uuid, p_qty numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  line uuid;
begin
  perform private.shop_can_edit(wo);
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantity must be more than zero' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.catalog_items c
    where c.id = p_catalog_item and c.active and c.shop_selectable and c.category <> 'service'
  ) then
    raise exception 'Pick a part from the catalog. Services need an extra work request.' using errcode = 'P0001';
  end if;
  insert into public.work_order_lines (work_order_id, catalog_item_id, qty, origin)
  values (wo.id, p_catalog_item, p_qty, 'shop_added')
  returning id into line;
  perform private.log_event(wo.id, 'line_added', null, null, 'Shop added a part', true);
  return line;
end $$;

create function public.shop_remove_part(p_work_order uuid, p_line uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  perform private.shop_can_edit(wo);
  delete from public.work_order_lines where id = p_line and work_order_id = wo.id and origin = 'shop_added';
  if not found then
    raise exception 'Only parts your shop added can be removed' using errcode = 'P0001';
  end if;
end $$;

create function public.shop_request_authorization(
  p_work_order uuid, p_catalog_item uuid, p_qty numeric, p_note text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  item record;
  req uuid;
begin
  perform private.shop_can_edit(wo);
  select c.category into item from public.catalog_items c where c.id = p_catalog_item and c.active;
  if not found then
    raise exception 'Pick an item from the catalog' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Describe the extra work' using errcode = 'P0001';
  end if;
  insert into public.authorization_requests (work_order_id, seq, kind, catalog_item_id, qty, note, requested_by)
  values (wo.id,
          coalesce((select max(seq) from public.authorization_requests where work_order_id = wo.id), 0) + 1,
          case when item.category = 'service' then 'service'::public.auth_req_kind else 'part'::public.auth_req_kind end,
          p_catalog_item, coalesce(p_qty, 1), btrim(p_note), auth.uid())
  returning id into req;
  perform private.log_event(wo.id, 'auth_request', null, null, 'Shop requested extra work', true);
  return req;
end $$;

-- All completion rules in one place. Returns nothing; raises the first problem found.
create function public.shop_complete_work_order(p_work_order uuid, p_invoice_ref text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  c record;
  label text;
begin
  perform private.shop_can_edit(wo);
  if coalesce(btrim(p_invoice_ref), '') = '' then
    raise exception 'Enter your invoice or reference number' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.work_order_components where work_order_id = wo.id) then
    raise exception 'Add at least one component' using errcode = 'P0001';
  end if;

  for c in select * from public.work_order_components where work_order_id = wo.id order by seq loop
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

  if exists (select 1 from public.authorization_requests where work_order_id = wo.id and status = 'pending') then
    raise exception 'An extra work request is still waiting for CDS' using errcode = 'P0001';
  end if;

  update public.work_orders
     set status = 'completed', completed_at = now(), affiliate_invoice_ref = btrim(p_invoice_ref),
         shop_ship_status = case when fulfillment = 'shipping' then 'ready_to_ship' else shop_ship_status end
   where id = wo.id;
  perform private.log_event(wo.id, 'complete', wo.status, 'completed', 'Completed by shop', true);
end $$;

-- ---------------------------------------------------------------- CDS actions

create function public.cds_create_work_order(
  p_customer uuid,
  p_location uuid,
  p_location_label text,
  p_site_address text,
  p_request_type public.request_type,
  p_fulfillment public.fulfillment_method,
  p_unit_number text,
  p_po_number text,
  p_requested_work text,
  p_internal_notes text,
  p_lines jsonb  -- [{ "catalog_item_id": uuid, "qty": number }]
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo uuid;
  line jsonb;
  loc_code text;
  loc_name text;
  loc_address text;
  loc_notes text;
begin
  perform private.require_cds();
  if coalesce(btrim(p_unit_number), '') = '' or coalesce(btrim(p_requested_work), '') = '' then
    raise exception 'Unit number and requested work are required' using errcode = 'P0001';
  end if;
  if p_location is not null then
    select l.code, l.name, l.address_raw, l.routing_notes into loc_code, loc_name, loc_address, loc_notes
    from public.customer_locations l where l.id = p_location and l.customer_id = p_customer;
    if not found then
      raise exception 'That location does not belong to this customer' using errcode = 'P0001';
    end if;
  end if;

  insert into public.work_orders
    (customer_id, location_id, location_label, site_address, request_type, fulfillment,
     unit_number, po_number, requested_work)
  values
    (p_customer, p_location, coalesce(nullif(btrim(p_location_label), ''), loc_code || ' ' || loc_name, 'Unknown location'),
     coalesce(nullif(btrim(p_site_address), ''), loc_address), p_request_type, p_fulfillment,
     btrim(p_unit_number), nullif(btrim(p_po_number), ''), btrim(p_requested_work))
  returning id into wo;

  insert into public.work_order_internal (work_order_id, source, internal_notes, routing_notes, review_reason)
  values (wo, 'manual', nullif(btrim(p_internal_notes), ''), loc_notes,
          case when p_location is null then 'Location not matched'
               when coalesce(btrim(p_po_number), '') = '' then 'PO number missing' end);

  for line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.work_order_lines (work_order_id, catalog_item_id, qty, origin)
    values (wo, (line ->> 'catalog_item_id')::uuid, (line ->> 'qty')::numeric, 'cds_order');
  end loop;

  perform private.log_event(wo, 'create', null, 'pending_review', 'Work order created', false);
  return wo;
end $$;

create function public.cds_dispatch_work_order(p_work_order uuid, p_affiliate uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  shop record;
begin
  perform private.require_cds();
  select * into wo from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status not in ('pending_review', 'awaiting_acceptance', 'rejected_by_affiliate') then
    raise exception 'Only a work order in review or awaiting acceptance can be dispatched' using errcode = 'P0001';
  end if;
  select a.display_name into shop from public.affiliates a where a.id = p_affiliate and a.active;
  if not found then
    raise exception 'Choose an active shop' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.work_order_lines where work_order_id = wo.id) then
    raise exception 'Add at least one service or part before dispatch' using errcode = 'P0001';
  end if;

  update public.work_orders
     set affiliate_id = p_affiliate, status = 'awaiting_acceptance', dispatched_at = now()
   where id = wo.id;
  update public.work_order_internal
     set approved_by = auth.uid(), approved_at = now(), review_reason = null
   where work_order_id = wo.id;
  perform private.log_event(wo.id, 'dispatch', wo.status, 'awaiting_acceptance',
    'Approved and dispatched to ' || shop.display_name, true);
end $$;

-- CDS status moves after the shop is done, plus cancel.
create function public.cds_set_status(p_work_order uuid, p_status public.wo_status, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  allowed boolean;
begin
  perform private.require_cds();
  select * into wo from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  allowed := case p_status
    when 'delivered' then wo.status = 'completed'
    when 'ready_to_invoice' then wo.status in ('completed', 'delivered')
    when 'cancelled' then wo.status not in ('invoiced', 'cancelled')
    when 'pending_review' then wo.status in ('awaiting_acceptance', 'rejected_by_affiliate')
    else false
  end;
  if not allowed then
    raise exception 'Cannot move from % to %', wo.status, p_status using errcode = 'P0001';
  end if;
  update public.work_orders
     set status = p_status,
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end
   where id = wo.id;
  if p_status = 'ready_to_invoice' then
    update public.work_order_internal set ready_to_invoice_at = now() where work_order_id = wo.id;
  end if;
  perform private.log_event(wo.id, 'status_change', wo.status, p_status,
    coalesce(nullif(btrim(p_note), ''), 'Status set by CDS'), p_status in ('cancelled', 'delivered'));
end $$;

-- Approving needs the customer's approval on record (confirmed with CDS 2026-10-07).
create function public.cds_decide_authorization(
  p_request uuid, p_approve boolean, p_decision_note text, p_customer_approved_by text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  req public.authorization_requests;
begin
  perform private.require_cds();
  select * into req from public.authorization_requests where id = p_request for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if req.status <> 'pending' then
    raise exception 'This request was already decided' using errcode = 'P0001';
  end if;

  if p_approve then
    if coalesce(btrim(p_customer_approved_by), '') = '' then
      raise exception 'Record who at the customer approved the extra work' using errcode = 'P0001';
    end if;
    update public.authorization_requests
       set status = 'approved', decided_by = auth.uid(), decided_at = now(),
           customer_approval = 'approved', customer_approval_at = now()
     where id = req.id;
    insert into public.authorization_decisions
      (request_id, decision_note, customer_approved_by_name, customer_approval_recorded_by)
    values (req.id, nullif(btrim(p_decision_note), ''), btrim(p_customer_approved_by), auth.uid());
    insert into public.work_order_lines (work_order_id, catalog_item_id, qty, origin, auth_request_id)
    values (req.work_order_id, req.catalog_item_id, req.qty, 'auth_request', req.id);
    perform private.log_event(req.work_order_id, 'auth_decision', null, null, 'Extra work approved', true);
  else
    update public.authorization_requests
       set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
           customer_approval = case when customer_approval = 'requested' then 'declined' else customer_approval end
     where id = req.id;
    insert into public.authorization_decisions (request_id, decision_note)
    values (req.id, nullif(btrim(p_decision_note), ''));
    perform private.log_event(req.work_order_id, 'auth_decision', null, null, 'Extra work declined', true);
  end if;
end $$;

-- ---------------------------------------------------------------- grants

do $$
declare f text;
begin
  foreach f in array array[
    'shop_accept_work_order(uuid, public.pickup_window)',
    'shop_decline_work_order(uuid, text)',
    'shop_set_progress(uuid, public.wo_status)',
    'shop_set_ship_status(uuid, public.shop_ship_status)',
    'shop_save_component(uuid, uuid, public.component_type, text, text, text, numeric, numeric, numeric, numeric, public.component_result, text)',
    'shop_delete_component(uuid, uuid)',
    'shop_add_part(uuid, uuid, numeric)',
    'shop_remove_part(uuid, uuid)',
    'shop_request_authorization(uuid, uuid, numeric, text)',
    'shop_complete_work_order(uuid, text)',
    'cds_create_work_order(uuid, uuid, text, text, public.request_type, public.fulfillment_method, text, text, text, text, jsonb)',
    'cds_dispatch_work_order(uuid, uuid)',
    'cds_set_status(uuid, public.wo_status, text)',
    'cds_decide_authorization(uuid, boolean, text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on function private.log_event(uuid, text, public.wo_status, public.wo_status, text, boolean) from public;
revoke all on function private.my_work_order(uuid) from public;
revoke all on function private.shop_can_edit(public.work_orders) from public;
