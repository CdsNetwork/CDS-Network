-- Invoice any time (Sarah, CDS dispatch, 2026-11-12: CDS may create the customer invoice "any
-- time, please", not only after the shop completes the job).
--
-- 1. private.wo_invoiced(order): true when the order is invoiced, or has a QuickBooks invoice
--    recorded (work_order_internal.qb_invoice_id) while the shop is still working on it.
-- 2. public.cds_mark_invoiced records the QuickBooks invoice at any status except cancelled
--    and invoiced, once per order. A done order (completed, delivered, ready to invoice) moves
--    to Invoiced as before; any other order keeps its status.
-- 3. public.shop_complete_work_order (same as 20261112010000_condemned_no_measurements.sql
--    otherwise): an order with a QuickBooks invoice goes straight to Invoiced instead of
--    Completed. In-house orders complete through the same function.
-- 4. Locks while private.wo_invoiced is true, so the order stays in step with QuickBooks:
--      * work_order_lines: no line added or removed and no quantity or description change
--        (CDS, the shop adding a part, an approved extra work request, Misc. hardware). Shop
--        rates stay open: they are shop pay, not on the customer invoice.
--      * work_order_line_pricing: customer prices do not change.
--      * work_orders: the customer and location do not change.
--      * work_order_internal: the tax settings do not change (private.tax_locked_when_invoiced),
--        and a customer's tax exemption change no longer touches these orders.
--      * public.cds_set_status: the order cannot be cancelled.
--    The line, price and customer locks apply to signed-in callers (CDS and shops, also inside
--    the security definer functions they call); the service role (fixtures, intake on new
--    drafts) is not stopped, like private.guard_in_house_shop.
-- Grants are unchanged: no new public function; private functions are revoked from public.

-- ---------------------------------------------------------------- 1. invoiced or has an invoice

create function private.wo_invoiced(p_work_order uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.work_orders w
      left join public.work_order_internal i on i.work_order_id = w.id
     where w.id = p_work_order and (w.status = 'invoiced' or i.qb_invoice_id is not null)
  )
$$;
revoke all on function private.wo_invoiced(uuid) from public;

-- ---------------------------------------------------------------- 2. record the invoice

create or replace function public.cds_mark_invoiced(p_work_order uuid, p_qb_invoice_id text, p_qb_invoice_number text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  existing text;
  invoice_id text := btrim(p_qb_invoice_id);
  name text;
  new_status public.wo_status;
begin
  perform private.require_cds();
  if coalesce(invoice_id, '') = '' then
    raise exception 'The QuickBooks invoice id is missing' using errcode = 'P0001';
  end if;
  perform private.check_length(invoice_id, 50);
  perform private.check_length(btrim(p_qb_invoice_number), 50);

  select * into wo from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status = 'invoiced' then
    raise exception 'This work order is already invoiced' using errcode = 'P0001';
  end if;
  if wo.status = 'cancelled' then
    raise exception 'A cancelled work order cannot be invoiced' using errcode = 'P0001';
  end if;
  select i.qb_invoice_id into existing from public.work_order_internal i where i.work_order_id = wo.id for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if existing is not null and existing <> invoice_id then
    raise exception 'This work order already has QuickBooks invoice %', existing using errcode = 'P0001';
  end if;

  new_status := case when wo.status in ('completed', 'delivered', 'ready_to_invoice') then 'invoiced' else wo.status end;
  -- The same invoice again on an order the shop is still working on: already recorded.
  if existing is not null and new_status = wo.status then
    return;
  end if;

  update public.work_order_internal
     set qb_invoice_id = invoice_id,
         qb_invoice_number = nullif(btrim(p_qb_invoice_number), ''),
         invoiced_at = now()
   where work_order_id = wo.id;
  if new_status = 'invoiced' then
    update public.work_orders set status = 'invoiced' where id = wo.id;
  end if;
  name := coalesce(nullif(btrim(p_qb_invoice_number), ''), 'id ' || invoice_id);
  perform private.log_event(wo.id, 'invoice', wo.status, new_status,
    case when new_status = 'invoiced' then 'QuickBooks invoice ' || name || ' created'
         else 'QuickBooks invoice ' || name || ' created; the order moves to Invoiced when the shop completes it' end,
    false);
end $$;

-- ---------------------------------------------------------------- 3. completion

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

-- ---------------------------------------------------------------- 4. locks

-- No cancel once the order has a QuickBooks invoice (an invoiced order could not be cancelled
-- before either). Otherwise as in 20261015000000_qa_round1_fixes.sql.
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
  if p_status = 'cancelled' and wo.status <> 'invoiced' and private.wo_invoiced(wo.id) then
    raise exception 'This work order is invoiced in QuickBooks, so it cannot be cancelled' using errcode = 'P0001';
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

-- Customer lines: none added or removed, no quantity or description change.
create function private.lines_locked_when_invoiced() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and (new.qty, new.description) is not distinct from (old.qty, old.description) then
    return new;
  end if;
  if private.wo_invoiced(coalesce(new.work_order_id, old.work_order_id)) then
    raise exception 'Lines cannot change once the work order is invoiced' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function private.lines_locked_when_invoiced() from public;

create trigger lines_locked_when_invoiced
  before insert or delete or update of qty, description on public.work_order_lines
  for each row execute function private.lines_locked_when_invoiced();

-- Customer prices on the lines.
create function private.line_prices_locked_when_invoiced() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and (new.customer_unit_price, new.tax_class) is not distinct from (old.customer_unit_price, old.tax_class) then
    return new;
  end if;
  if private.wo_invoiced(coalesce(new.work_order_id, old.work_order_id)) then
    raise exception 'Prices cannot change once the work order is invoiced' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function private.line_prices_locked_when_invoiced() from public;

create trigger line_prices_locked_when_invoiced
  before update or delete on public.work_order_line_pricing
  for each row execute function private.line_prices_locked_when_invoiced();

-- Customer and location.
create function private.order_locked_when_invoiced() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null
     and (new.customer_id, new.location_id) is distinct from (old.customer_id, old.location_id)
     and private.wo_invoiced(old.id) then
    raise exception 'The customer and location cannot change after the order is invoiced' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.order_locked_when_invoiced() from public;

create trigger order_locked_when_invoiced
  before update of customer_id, location_id on public.work_orders
  for each row execute function private.order_locked_when_invoiced();

-- Tax: as in 20261019050000_tax_customer_change_and_invoiced_lock.sql, for an order with a
-- QuickBooks invoice too.
create or replace function private.tax_locked_when_invoiced() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.tax_rate, new.tax_parts, new.tax_labor, new.tax_shipping, new.tax_source, new.tax_jurisdiction)
       is distinct from (old.tax_rate, old.tax_parts, old.tax_labor, old.tax_shipping, old.tax_source, old.tax_jurisdiction)
     and (old.qb_invoice_id is not null or private.wo_invoiced(new.work_order_id)) then
    raise exception 'Tax cannot change after the order is invoiced.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- A customer's exemption no longer changes the tax of its orders that have a QuickBooks
-- invoice. Otherwise as in 20261019060000_cancelled_orders_keep_tax.sql.
create or replace function private.tax_follows_exemption() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
begin
  select * into wo from public.work_orders where id = new.work_order_id;
  if wo.status in ('invoiced', 'cancelled') or (tg_op = 'UPDATE' and old.qb_invoice_id is not null) then
    return new;
  end if;
  if coalesce((select b.tax_exempt from public.customer_billing b where b.customer_id = wo.customer_id), false) then
    new.tax_rate := 0;
    new.tax_parts := false;
    new.tax_labor := false;
    new.tax_shipping := false;
    new.tax_source := 'customer_exempt';
  end if;
  return new;
end $$;

create or replace function private.exemption_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.tax_exempt is not distinct from old.tax_exempt then
    return null;
  end if;
  if new.tax_exempt then
    -- The before trigger above sets the no tax settings.
    update public.work_order_internal i
       set tax_source = 'customer_exempt'
      from public.work_orders w
     where w.id = i.work_order_id and w.customer_id = new.customer_id and w.status not in ('invoiced', 'cancelled')
       and i.qb_invoice_id is null;
  elsif tg_op = 'UPDATE' then
    update public.work_order_internal i
       set tax_rate = s.rate, tax_parts = s.taxes_parts, tax_labor = s.taxes_labor,
           tax_shipping = s.taxes_shipping, tax_jurisdiction = coalesce(s.jurisdiction, i.tax_jurisdiction),
           tax_source = s.source
      from public.work_orders w
      cross join lateral private.starting_tax(w.location_id) s
     where w.id = i.work_order_id and w.customer_id = new.customer_id and w.status not in ('invoiced', 'cancelled')
       and i.qb_invoice_id is null
       and i.tax_source = 'customer_exempt';
  end if;
  return null;
end $$;
