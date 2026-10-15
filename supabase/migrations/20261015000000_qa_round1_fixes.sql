-- QA round 1 fixes (2026-10-15).
--
-- 1. Rows that hang off a work order remember which shop they belong to, so a job moved
--    to another shop never shows the new shop the previous shop's history or work.
-- 2. Reassignment removes the previous shop's own parts lines and withdraws its pending
--    extra work requests. CDS keeps components, files and history for its records.
-- 3. Shop pay rates remember where they came from, so a reassignment only changes a rate
--    when the shop's own rate is involved, never because the default rate changed since.
-- 4. Free text has length limits.

-- ---------------------------------------------------------------- length limits

create function private.check_length(val text, max_len int) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if val is not null and char_length(val) > max_len then
    raise exception 'Text is too long (max % characters)', max_len using errcode = 'P0001';
  end if;
end $$;
revoke all on function private.check_length(text, int) from public;

-- ---------------------------------------------------------------- shop stamp

alter table public.work_order_events      add column affiliate_id uuid references public.affiliates;
alter table public.work_order_components  add column affiliate_id uuid references public.affiliates;
alter table public.attachments            add column affiliate_id uuid references public.affiliates;
alter table public.authorization_requests add column affiliate_id uuid references public.affiliates;

create index on public.work_order_events (work_order_id, affiliate_id);
create index on public.work_order_components (work_order_id, affiliate_id);
create index on public.attachments (work_order_id, affiliate_id);
create index on public.authorization_requests (work_order_id, affiliate_id);

-- Backfill from each work order's current shop.
update public.work_order_events e set affiliate_id = w.affiliate_id
  from public.work_orders w where w.id = e.work_order_id and e.affiliate_id is null;
update public.work_order_components c set affiliate_id = w.affiliate_id
  from public.work_orders w where w.id = c.work_order_id and c.affiliate_id is null;
update public.attachments a set affiliate_id = w.affiliate_id
  from public.work_orders w where w.id = a.work_order_id and a.affiliate_id is null;
update public.authorization_requests r set affiliate_id = w.affiliate_id
  from public.work_orders w where w.id = r.work_order_id and r.affiliate_id is null;

-- A new row belongs to the shop that has the work order at that moment. Status changes
-- and dispatches update the work order first, so their events carry the new shop.
create function private.stamp_affiliate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.affiliate_id is null then
    select w.affiliate_id into new.affiliate_id from public.work_orders w where w.id = new.work_order_id;
  end if;
  return new;
end $$;
revoke all on function private.stamp_affiliate() from public;

create trigger stamp_affiliate before insert on public.work_order_events
  for each row execute function private.stamp_affiliate();
create trigger stamp_affiliate before insert on public.work_order_components
  for each row execute function private.stamp_affiliate();
create trigger stamp_affiliate before insert on public.attachments
  for each row execute function private.stamp_affiliate();
create trigger stamp_affiliate before insert on public.authorization_requests
  for each row execute function private.stamp_affiliate();

-- Shop read policies: only rows of the shop's own time on the job. Rows with no shop
-- (entered while the order had none) belong to the order and stay visible.
drop policy shop_read on public.work_order_events;
create policy shop_read on public.work_order_events for select to authenticated
  using (shop_visible
         and affiliate_id = (select private.my_affiliate())
         and private.shop_can_see_wo(work_order_id));

drop policy shop_read on public.work_order_components;
create policy shop_read on public.work_order_components for select to authenticated
  using (private.shop_can_see_wo(work_order_id)
         and (affiliate_id is null or affiliate_id = (select private.my_affiliate())));

drop policy shop_read on public.attachments;
create policy shop_read on public.attachments for select to authenticated
  using (shop_visible
         and private.shop_can_see_wo(work_order_id)
         and (affiliate_id is null or affiliate_id = (select private.my_affiliate())));

drop policy shop_read on public.authorization_requests;
create policy shop_read on public.authorization_requests for select to authenticated
  using (private.shop_can_see_wo(work_order_id)
         and (affiliate_id is null or affiliate_id = (select private.my_affiliate())));

-- The storage read policy (private.ensure_storage) reads public.attachments as the
-- caller, so the attachments policy above also decides which files a shop can download.

-- ---------------------------------------------------------------- column limits

-- Constraints for the limits above. Older rows longer than a limit (only test input on
-- staging) are cut to the limit first, so every row satisfies the constraints.
update public.work_orders set unit_number = left(unit_number, 100) where char_length(unit_number) > 100;
update public.work_orders set po_number = left(po_number, 100) where char_length(po_number) > 100;
update public.work_orders set location_label = left(location_label, 200) where char_length(location_label) > 200;
update public.work_orders set site_address = left(site_address, 500) where char_length(site_address) > 500;
update public.work_orders set requested_work = left(requested_work, 2000) where char_length(requested_work) > 2000;
update public.work_orders set affiliate_invoice_ref = left(affiliate_invoice_ref, 100) where char_length(affiliate_invoice_ref) > 100;
update public.work_order_internal set internal_notes = left(internal_notes, 2000) where char_length(internal_notes) > 2000;
update public.work_order_internal set review_reason = left(review_reason, 2500) where char_length(review_reason) > 2500;
update public.authorization_requests set note = left(note, 2000) where char_length(note) > 2000;
update public.authorization_decisions set decision_note = left(decision_note, 2000) where char_length(decision_note) > 2000;
update public.authorization_decisions set customer_approved_by_name = left(customer_approved_by_name, 200)
  where char_length(customer_approved_by_name) > 200;
update public.work_order_components set manufacturer = left(manufacturer, 100) where char_length(manufacturer) > 100;
update public.work_order_components set part_number = left(part_number, 100) where char_length(part_number) > 100;
update public.work_order_components set serial_number = left(serial_number, 100) where char_length(serial_number) > 100;
update public.work_order_components set result_note = left(result_note, 2000) where char_length(result_note) > 2000;
update public.attachments set note = left(note, 2000) where char_length(note) > 2000;
update public.work_order_events set message = left(message, 2500) where char_length(message) > 2500;

alter table public.work_orders
  add constraint work_orders_unit_number_len check (char_length(unit_number) <= 100),
  add constraint work_orders_po_number_len check (char_length(po_number) <= 100),
  add constraint work_orders_location_label_len check (char_length(location_label) <= 200),
  add constraint work_orders_site_address_len check (char_length(site_address) <= 500),
  add constraint work_orders_requested_work_len check (char_length(requested_work) <= 2000),
  add constraint work_orders_invoice_ref_len check (char_length(affiliate_invoice_ref) <= 100);
alter table public.work_order_internal
  add constraint work_order_internal_notes_len check (char_length(internal_notes) <= 2000),
  add constraint work_order_internal_review_reason_len check (char_length(review_reason) <= 2500);
alter table public.authorization_requests
  add constraint authorization_requests_note_len check (char_length(note) <= 2000);
alter table public.authorization_decisions
  add constraint authorization_decisions_note_len check (char_length(decision_note) <= 2000),
  add constraint authorization_decisions_by_len check (char_length(customer_approved_by_name) <= 200);
alter table public.work_order_components
  add constraint work_order_components_manufacturer_len check (char_length(manufacturer) <= 100),
  add constraint work_order_components_part_number_len check (char_length(part_number) <= 100),
  add constraint work_order_components_serial_number_len check (char_length(serial_number) <= 100),
  add constraint work_order_components_result_note_len check (char_length(result_note) <= 2000);
alter table public.attachments
  add constraint attachments_note_len check (char_length(note) <= 2000);
alter table public.work_order_events
  add constraint work_order_events_message_len check (char_length(message) <= 2500);

-- ---------------------------------------------------------------- rate source

alter table public.work_order_lines
  add column shop_rate_source text not null default 'default'
    check (shop_rate_source in ('default', 'shop', 'manual'));

-- The freeze trigger blocks rate source changes from here on, so backfill first.
update public.work_order_lines l set shop_rate_source = 'shop'
  from public.work_orders w
 where w.id = l.work_order_id and w.affiliate_id is not null
   and exists (select 1 from public.shop_rates r
               where r.catalog_item_id = l.catalog_item_id and r.affiliate_id = w.affiliate_id);

create or replace function private.snapshot_shop_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  own numeric;
begin
  select w.affiliate_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  if new.shop_unit_rate is not null and private.is_cds() then
    -- A rate CDS typed in for this line.
    new.shop_rate_source := 'manual';
  else
    own := private.shop_own_rate_for(new.catalog_item_id, wo.affiliate_id, wo.market, current_date);
    if own is not null then
      new.shop_unit_rate := own;
      new.shop_rate_source := 'shop';
    else
      new.shop_unit_rate := private.shop_rate_for(new.catalog_item_id, null, wo.market, current_date);
      new.shop_rate_source := 'default';
    end if;
  end if;
  if new.added_by is null then
    new.added_by := auth.uid();
  end if;
  return new;
end $$;

-- A shop's own rate only (no fallback to the default).
create function private.shop_own_rate_for(item uuid, shop uuid, mkt public.market_code, on_date date)
returns numeric language sql stable security definer set search_path = '' as $$
  select r.amount from public.shop_rates r
  where shop is not null and r.catalog_item_id = item and r.market = mkt and r.affiliate_id = shop
    and r.effective_from <= on_date and (r.effective_to is null or r.effective_to > on_date)
  order by r.effective_from desc
  limit 1
$$;
revoke all on function private.shop_own_rate_for(uuid, uuid, public.market_code, date) from public;

-- Snapshots are fixed once taken. Only the reassignment re-snapshot may change the rate
-- and its source.
create or replace function private.freeze_line_prices() returns trigger
language plpgsql set search_path = '' as $$
begin
  if ((new.shop_unit_rate is distinct from old.shop_unit_rate
       or new.shop_rate_source is distinct from old.shop_rate_source)
      and coalesce(current_setting('cds.resnapshot', true), '') <> 'on')
     or new.catalog_item_id is distinct from old.catalog_item_id
     or new.work_order_id is distinct from old.work_order_id then
    raise exception 'Line item and snapshotted rate cannot change; remove the line and add a new one'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- A work order moved to another shop (or dispatched for the first time):
--   * the previous shop's own parts lines are removed (not payable to the new shop),
--   * the previous shop's pending extra work requests are withdrawn,
--   * each line is re-snapshotted for the new shop, using rates in effect on the day the
--     line was created: the new shop's own rate if it has one; else, if the line carried
--     the previous shop's own rate, the default rate; else (default or CDS-typed) the
--     rate stays as it is, so a later default rate change never alters the order.
create or replace function private.resnapshot_on_reassign() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  l record;
  own numeric;
begin
  if old.affiliate_id is not null then
    delete from public.work_order_lines where work_order_id = new.id and origin = 'shop_added';
    update public.authorization_requests set status = 'withdrawn'
     where work_order_id = new.id and status = 'pending';
  end if;

  perform set_config('cds.resnapshot', 'on', true);
  for l in select ln.id, ln.catalog_item_id, ln.created_at, ln.shop_rate_source
             from public.work_order_lines ln where ln.work_order_id = new.id loop
    own := private.shop_own_rate_for(l.catalog_item_id, new.affiliate_id, new.market, l.created_at::date);
    if own is not null then
      update public.work_order_lines set shop_unit_rate = own, shop_rate_source = 'shop' where id = l.id;
    elsif l.shop_rate_source = 'shop' then
      update public.work_order_lines
         set shop_unit_rate = coalesce(
               private.shop_rate_for(l.catalog_item_id, null, new.market, l.created_at::date),
               private.shop_rate_for(l.catalog_item_id, null, new.market, current_date)),
             shop_rate_source = 'default'
       where id = l.id;
    end if;
  end loop;
  perform set_config('cds.resnapshot', '', true);
  return null;
end $$;

-- ---------------------------------------------------------------- shop actions

create or replace function public.shop_decline_work_order(p_work_order uuid, p_reason text)
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
  perform private.check_length(btrim(p_reason), 2000);
  select display_name into shop_name from public.affiliates where id = wo.affiliate_id;
  update public.work_orders set status = 'rejected_by_affiliate', pickup_window = null where id = wo.id;
  update public.work_order_internal
     set review_reason = 'Declined by ' || shop_name || ': ' || btrim(p_reason)
   where work_order_id = wo.id;
  perform private.log_event(wo.id, 'decline', wo.status, 'rejected_by_affiliate',
    'Declined by ' || shop_name || ': ' || btrim(p_reason), false);
end $$;

create or replace function public.shop_save_component(
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
  perform private.check_length(btrim(p_manufacturer), 100);
  perform private.check_length(btrim(p_part_number), 100);
  perform private.check_length(btrim(p_serial_number), 100);
  perform private.check_length(btrim(p_result_note), 2000);
  if p_component is null then
    insert into public.work_order_components
      (work_order_id, affiliate_id, seq, component_type, manufacturer, part_number, serial_number,
       dp_before, dp_after, weight_before_g, weight_after_g, result, result_note, updated_by)
    values
      (wo.id, wo.affiliate_id,
       coalesce((select max(seq) from public.work_order_components where work_order_id = wo.id), 0) + 1,
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
       and (affiliate_id = wo.affiliate_id or affiliate_id is null)
    returning id into saved;
    if saved is null then
      raise exception 'Component not found' using errcode = 'P0002';
    end if;
  end if;
  return saved;
end $$;

create or replace function public.shop_delete_component(p_work_order uuid, p_component uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
begin
  perform private.shop_can_edit(wo);
  delete from public.work_order_components
   where id = p_component and work_order_id = wo.id
     and (affiliate_id = wo.affiliate_id or affiliate_id is null);
end $$;

create or replace function public.shop_request_authorization(
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
  perform private.check_length(btrim(p_note), 2000);
  insert into public.authorization_requests (work_order_id, affiliate_id, seq, kind, catalog_item_id, qty, note, requested_by)
  values (wo.id, wo.affiliate_id,
          coalesce((select max(seq) from public.authorization_requests where work_order_id = wo.id), 0) + 1,
          case when item.category = 'service' then 'service'::public.auth_req_kind else 'part'::public.auth_req_kind end,
          p_catalog_item, coalesce(p_qty, 1), btrim(p_note), auth.uid())
  returning id into req;
  perform private.log_event(wo.id, 'auth_request', null, null, 'Shop requested extra work', true);
  return req;
end $$;

-- All completion rules in one place, over this shop's own components and requests only.
create or replace function public.shop_complete_work_order(p_work_order uuid, p_invoice_ref text)
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
  perform private.check_length(btrim(p_invoice_ref), 100);
  if not exists (
    select 1 from public.work_order_components
    where work_order_id = wo.id and (affiliate_id = wo.affiliate_id or affiliate_id is null)
  ) then
    raise exception 'Add at least one component' using errcode = 'P0001';
  end if;

  for c in select * from public.work_order_components
            where work_order_id = wo.id and (affiliate_id = wo.affiliate_id or affiliate_id is null)
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
     set status = 'completed', completed_at = now(), affiliate_invoice_ref = btrim(p_invoice_ref),
         shop_ship_status = case when fulfillment = 'shipping' then 'ready_to_ship' else shop_ship_status end
   where id = wo.id;
  perform private.log_event(wo.id, 'complete', wo.status, 'completed', 'Completed by shop', true);
end $$;

-- ---------------------------------------------------------------- CDS actions

create or replace function public.cds_create_work_order(
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
  perform private.check_length(btrim(p_unit_number), 100);
  perform private.check_length(btrim(p_po_number), 100);
  perform private.check_length(btrim(p_location_label), 200);
  perform private.check_length(btrim(p_site_address), 500);
  perform private.check_length(btrim(p_requested_work), 2000);
  perform private.check_length(btrim(p_internal_notes), 2000);
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
    (p_customer, p_location,
     left(coalesce(nullif(btrim(p_location_label), ''), loc_code || ' ' || loc_name, 'Unknown location'), 200),
     left(coalesce(nullif(btrim(p_site_address), ''), loc_address), 500), p_request_type, p_fulfillment,
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

create or replace function public.cds_set_status(p_work_order uuid, p_status public.wo_status, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  allowed boolean;
begin
  perform private.require_cds();
  perform private.check_length(btrim(p_note), 2000);
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

create or replace function public.cds_decide_authorization(
  p_request uuid, p_approve boolean, p_decision_note text, p_customer_approved_by text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  req public.authorization_requests;
begin
  perform private.require_cds();
  perform private.check_length(btrim(p_decision_note), 2000);
  perform private.check_length(btrim(p_customer_approved_by), 200);
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
