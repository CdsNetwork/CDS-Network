-- Shop bill approval, and shops adding parts without an authorization request (Sarah, CDS,
-- 2026-11-23).
--
-- CDS requires shops to bill some parts as kits, but shops bill loose parts. Until now the
-- shop's QuickBooks bill was sent automatically when the shop completed the job. Now every
-- completed order's shop bill waits for CDS ("every order please"), also in-house orders once
-- the in-house shop is linked to a vendor: CDS checks the lines (and corrects them), then
-- "Approve and send to QuickBooks" records the approval and sends the bill as before
-- (src/lib/qbo/bill-run.ts, unchanged retry rules). Nothing is sent on its own anymore.
-- Orders already completed with no bill yet wait for approval too; orders with a bill are
-- unchanged.
--
-- 1. work_order_internal.shop_bill_approved_at / shop_bill_approved_by: CDS only, like every
--    work_order_internal column (only the cds_all policy, so a shop reads and sets nothing).
--    Set only by public.cds_approve_shop_bill (or the service role): a CDS login setting it
--    directly is refused, so the approval always names the person who approved; clearing it
--    is always allowed (it only asks for a new approval). No grant change (the columns follow the table's grants).
-- 2. public.cds_approve_shop_bill(order) (CDS only): records the approval of a completed,
--    not cancelled order whose bill is not in QuickBooks yet, for a regular shop or the
--    in-house shop linked to a vendor; logged on the order's history (CDS only). The portal
--    checks first that the bill CDS saw is the bill being approved (same total).
-- 3. The approval is cleared, until the bill exists, when what the bill is made of changes:
--    a line added or removed, or its quantity, item, shop rate or description changed; the
--    shop's invoice number (the bill number) or the shop changed; the shipping credit turned
--    on or off. CDS then approves what is sent. Once the bill exists nothing is cleared.
-- 4. public.qbo_claim_shop_bill: same as 20261120000000_in_house_shop_bills.sql, plus: an
--    order whose bill is not in QuickBooks yet and that CDS has not approved is refused (the
--    server's bill run checks it too). An order with a bill still says so first.
-- 5. public.work_order_list (20261119200000_new_from_shop_first.sql) gets
--    shop_bill_pending_approval: completed (completed, delivered, ready to invoice or
--    invoiced, with a completion time), a regular shop or the in-house shop linked to a
--    vendor, no bill in QuickBooks or being created, not approved. Orders completed before
--    shop bills were turned on (app_settings qbo_bill_line "since"), or, in-house, before the
--    vendor link, are left out: CDS typed those bills by hand. The work order page still
--    offers the approval for them, with a warning. Dropped and created again like before (w.*
--    is expanded at creation); everything else unchanged.
-- 6. Shops add parts without asking (Sarah, CDS, 2026-11-23); extra services and labor still
--    go through Request Additional Authorization:
--      * public.shop_add_part: any active catalog item shops may select (shop_selectable),
--        except services, Misc. hardware (added with its amount, below) and items CDS prices
--        on each order (reconditioned and new filters: CDS adds those with the customer price,
--        as before). Messages say which way to go.
--      * public.shop_add_pass_through_line(order, item, description, amount) (new, shops):
--        an item priced per line and passed through (Misc. hardware), qty 1, at the amount on
--        the shop's invoice; the customer is billed the same amount, as when CDS adds it
--        (private.write_line_pricing, unchanged). Same editing window as shop_add_part; the
--        shop can remove its own line like any part it added (shop_remove_part).
--      * private.snapshot_shop_rate: same as 20261117030000_order_priced_without_amount.sql,
--        except that a Misc. hardware line may also come from that shop function.
--      * CDS-MISC-HARDWARE is offered to shops (shop_selectable true).
--    The shop still reads only its own rates and lines, never customer prices (RLS unchanged).
-- Grants: cds_approve_shop_bill and shop_add_pass_through_line to authenticated and
-- service_role (snapshot updated); the rest keep theirs.

-- ---------------------------------------------------------------- 1. columns

alter table public.work_order_internal
  add column shop_bill_approved_at timestamptz,
  add column shop_bill_approved_by uuid references public.profiles on delete set null,
  add constraint work_order_internal_shop_bill_approval_check
    check (shop_bill_approved_at is not null or shop_bill_approved_by is null);

comment on column public.work_order_internal.shop_bill_approved_at is
  'CDS only: when CDS approved the shop''s QuickBooks bill (public.cds_approve_shop_bill). Cleared when the lines, the bill number, the shop or the shipping credit change before the bill exists.';
comment on column public.work_order_internal.shop_bill_approved_by is
  'CDS only: who approved the shop''s QuickBooks bill.';

create function private.shop_bill_approval_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- The shipping credit changes the bill (its deduction): approve it again.
  if tg_op = 'UPDATE' and new.shop_shipping_credit is distinct from old.shop_shipping_credit
     and not private.wo_has_shop_bill(new.work_order_id) then
    new.shop_bill_approved_at := null;
    new.shop_bill_approved_by := null;
  end if;
  -- Clearing is always allowed; so is a change that leaves the approval as it is.
  if new.shop_bill_approved_at is null and new.shop_bill_approved_by is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.shop_bill_approved_at is not distinct from old.shop_bill_approved_at
     and new.shop_bill_approved_by is not distinct from old.shop_bill_approved_by then
    return new;
  end if;
  -- A signed-in user sets it only through public.cds_approve_shop_bill (which runs as its
  -- owner); the service role and the database owner (fixtures, maintenance) may set it.
  if current_user = 'authenticated' and coalesce(current_setting('cds.shop_bill_approval', true), '') <> 'on' then
    raise exception 'The shop bill is approved with Approve and send to QuickBooks on the work order.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.shop_bill_approval_guard() from public;

create trigger shop_bill_approval_guard
  before insert or update on public.work_order_internal
  for each row execute function private.shop_bill_approval_guard();

-- ---------------------------------------------------------------- 2. approve

create function public.cds_approve_shop_bill(p_work_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  in_house boolean;
  bill public.qbo_shop_bills;
begin
  perform private.require_cds();
  select * into wo from public.work_orders w where w.id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status = 'cancelled' then
    raise exception 'This work order is cancelled, so it gets no shop bill.' using errcode = 'P0001';
  end if;
  if wo.completed_at is null or wo.status not in ('completed', 'delivered', 'ready_to_invoice', 'invoiced') then
    raise exception 'The shop has not completed this work order yet.' using errcode = 'P0001';
  end if;
  select a.is_in_house into in_house from public.affiliates a where a.id = wo.affiliate_id;
  if in_house is null then
    raise exception 'This work order has no shop, so it gets no bill.' using errcode = 'P0001';
  end if;
  if in_house and not exists (select 1 from public.qbo_affiliate_vendor v where v.affiliate_id = wo.affiliate_id) then
    raise exception 'CDS''s own shop is not linked to a QuickBooks vendor, so it gets no bill.' using errcode = 'P0001';
  end if;
  select * into bill from public.qbo_shop_bills b where b.work_order_id = wo.id;
  if bill.status = 'created' then
    raise exception 'This work order already has QuickBooks bill %.', coalesce(bill.qb_bill_number, 'id ' || bill.qb_bill_id)
      using errcode = 'P0001';
  end if;

  perform set_config('cds.shop_bill_approval', 'on', true);
  update public.work_order_internal i
     set shop_bill_approved_at = now(), shop_bill_approved_by = auth.uid()
   where i.work_order_id = wo.id;
  if not found then
    insert into public.work_order_internal (work_order_id, shop_bill_approved_at, shop_bill_approved_by)
    values (wo.id, now(), auth.uid());
  end if;
  perform set_config('cds.shop_bill_approval', '', true);
  perform private.log_event(wo.id, 'shop_bill_approved', null, null, 'CDS approved the shop''s bill for QuickBooks', false);
end $$;

revoke all on function public.cds_approve_shop_bill(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_approve_shop_bill(uuid) to authenticated;
grant execute on function public.cds_approve_shop_bill(uuid) to service_role;

-- ---------------------------------------------------------------- 3. cleared on a change

create function private.clear_shop_bill_approval(p_work_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- A deleted order (its lines go with it): nothing to clear.
  if p_work_order is null or not exists (select 1 from public.work_orders w where w.id = p_work_order) then
    return;
  end if;
  if private.wo_has_shop_bill(p_work_order) then
    return;
  end if;
  perform set_config('cds.shop_bill_approval', 'on', true);
  update public.work_order_internal i
     set shop_bill_approved_at = null, shop_bill_approved_by = null
   where i.work_order_id = p_work_order and i.shop_bill_approved_at is not null;
  perform set_config('cds.shop_bill_approval', '', true);
end $$;
revoke all on function private.clear_shop_bill_approval(uuid) from public;

create function private.clear_shop_bill_approval_on_line() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform private.clear_shop_bill_approval(old.work_order_id);
  else
    perform private.clear_shop_bill_approval(new.work_order_id);
  end if;
  return null;
end $$;
revoke all on function private.clear_shop_bill_approval_on_line() from public;

create trigger shop_bill_approval_lines
  after insert or delete on public.work_order_lines
  for each row execute function private.clear_shop_bill_approval_on_line();
create trigger shop_bill_approval_line_change
  after update of qty, catalog_item_id, shop_unit_rate, description on public.work_order_lines
  for each row
  when (old.qty is distinct from new.qty or old.catalog_item_id is distinct from new.catalog_item_id
        or old.shop_unit_rate is distinct from new.shop_unit_rate or old.description is distinct from new.description)
  execute function private.clear_shop_bill_approval_on_line();

create function private.clear_shop_bill_approval_on_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.clear_shop_bill_approval(new.id);
  return null;
end $$;
revoke all on function private.clear_shop_bill_approval_on_order() from public;

create trigger shop_bill_approval_order_change
  after update of affiliate_invoice_ref, affiliate_id on public.work_orders
  for each row
  when (old.affiliate_invoice_ref is distinct from new.affiliate_invoice_ref or old.affiliate_id is distinct from new.affiliate_id)
  execute function private.clear_shop_bill_approval_on_order();

-- ---------------------------------------------------------------- 4. claim

create or replace function public.qbo_claim_shop_bill(p_work_order uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  in_house boolean;
  bill public.qbo_shop_bills;
  claim uuid;
begin
  select * into wo from public.work_orders w where w.id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if wo.status = 'cancelled' then
    raise exception 'This work order is cancelled, so it gets no shop bill.' using errcode = 'P0001';
  end if;
  if wo.completed_at is null then
    raise exception 'The shop has not completed this work order yet.' using errcode = 'P0001';
  end if;
  select a.is_in_house into in_house from public.affiliates a where a.id = wo.affiliate_id;
  if in_house is null then
    raise exception 'This work order has no shop, so it gets no bill.' using errcode = 'P0001';
  end if;
  if in_house and not exists (select 1 from public.qbo_affiliate_vendor v where v.affiliate_id = wo.affiliate_id) then
    raise exception 'CDS''s own shop is not linked to a QuickBooks vendor, so it gets no bill.' using errcode = 'P0001';
  end if;
  select * into bill from public.qbo_shop_bills b where b.work_order_id = wo.id;
  if bill.status = 'created' then
    raise exception 'This work order already has QuickBooks bill %.', coalesce(bill.qb_bill_number, 'id ' || bill.qb_bill_id)
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.work_order_internal i where i.work_order_id = wo.id and i.shop_bill_approved_at is not null
  ) then
    raise exception 'CDS has not approved this shop bill yet. Approve it on the work order first.' using errcode = 'P0001';
  end if;

  insert into public.qbo_shop_bills as b (work_order_id, status, claim_id, claimed_at)
  values (wo.id, 'creating', gen_random_uuid(), now())
  on conflict (work_order_id) do nothing
  returning b.claim_id into claim;

  if claim is null then
    select * into bill from public.qbo_shop_bills b where b.work_order_id = wo.id for update;
    if bill.status = 'created' then
      raise exception 'This work order already has QuickBooks bill %.', coalesce(bill.qb_bill_number, 'id ' || bill.qb_bill_id)
        using errcode = 'P0001';
    end if;
    if bill.status = 'creating' and bill.claimed_at > now() - interval '5 minutes' then
      raise exception 'A QuickBooks bill is already being created for this work order. Refresh in a moment.' using errcode = 'P0001';
    end if;
    update public.qbo_shop_bills b
       set status = 'creating', claim_id = gen_random_uuid(), claimed_at = now(), error = null
     where b.work_order_id = wo.id
    returning b.claim_id into claim;
  end if;

  select * into bill from public.qbo_shop_bills b where b.work_order_id = wo.id;
  return jsonb_build_object(
    'claim_id', claim,
    'request_id', 'bill-' || wo.id::text || case when bill.rejections > 0 then '-r' || bill.rejections::text else '' end
  );
end $$;

-- ---------------------------------------------------------------- 5. dashboard view

drop view public.work_order_list;

create view public.work_order_list with (security_invoker = true) as
select
  w.*,
  (case
    when w.status = 'pending_review' then 1
    when w.status not in ('invoiced', 'cancelled') and exists (
      select 1 from public.work_order_questions q
      where q.work_order_id = w.id and q.question_pending
    ) then 2
    when w.status = 'rejected_by_affiliate' then 3
    when w.status not in ('invoiced', 'cancelled') and exists (
      select 1 from public.work_order_components c
      where c.work_order_id = w.id and c.result = 'condemned'
    ) then 11
    when w.status = 'awaiting_acceptance' then 4
    when w.status = 'accepted' then 5
    when w.status = 'picked_up' then 6
    when w.status = 'in_process' then 7
    when w.status = 'completed' then 8
    when w.status = 'delivered' then 9
    when w.status = 'ready_to_invoice' then 10
    when w.status = 'invoiced' then 12
    when w.status = 'cancelled' then 13
    else 14
  end)::smallint as list_rank,
  (
    select string_agg(lower(regexp_replace(s.tracking_number, '\s', '', 'g')), ' ')
    from public.shipments s
    where s.work_order_id = w.id and s.tracking_number is not null
  ) as tracking_search,
  exists (
    select 1 from public.work_order_shop_activity a
    where a.work_order_id = w.id and a.is_new
  ) as new_from_shop,
  (
    w.status in ('completed', 'delivered', 'ready_to_invoice', 'invoiced')
    and w.completed_at is not null
    and exists (
      select 1 from public.affiliates a
      where a.id = w.affiliate_id
        and (not a.is_in_house or exists (
          select 1 from public.qbo_affiliate_vendor v where v.affiliate_id = a.id and w.completed_at >= v.linked_at
        ))
    )
    and not exists (
      select 1 from public.app_settings st
      where st.key = 'qbo_bill_line'
        and (st.value ->> 'since') ~ '^\d{4}-\d{2}-\d{2}'
        and w.completed_at < (st.value ->> 'since')::timestamptz
    )
    and not exists (
      select 1 from public.qbo_shop_bills b
      where b.work_order_id = w.id and (b.qb_bill_id is not null or b.status = 'creating')
    )
    and not exists (
      select 1 from public.work_order_internal i
      where i.work_order_id = w.id and (i.qb_bill_id is not null or i.shop_bill_approved_at is not null)
    )
  ) as shop_bill_pending_approval
from public.work_orders w
where (select private.is_cds());

comment on view public.work_order_list is
  'CDS dashboard work order table: work_orders plus list_rank (status order of the CDS tracking sheet), tracking_search (tracking numbers, no spaces, lower case), new_from_shop (shop activity CDS has not opened) and shop_bill_pending_approval (completed, the shop bill waits for CDS''s approval: AFF Bill Pnd Approval). CDS only.';

-- Grants (20261020000000_explicit_api_grants.sql), the same as public.work_order_financials.
revoke all on table public.work_order_list from public, anon, authenticated, service_role;
grant maintain, select on table public.work_order_list to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_list to service_role;

-- ---------------------------------------------------------------- 6. shops add parts

update public.catalog_items set shop_selectable = true where sku = 'CDS-MISC-HARDWARE';

-- Same as 20261117030000_order_priced_without_amount.sql, except that Misc. hardware may also
-- be added by the shop through public.shop_add_pass_through_line (cds.shop_amount).
create or replace function private.snapshot_shop_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo record;
  item record;
  picked_amount numeric;
  picked_source text;
begin
  select w.affiliate_id, w.customer_id, w.market into wo from public.work_orders w where w.id = new.work_order_id;
  select c.name, c.price_per_line, c.pass_through into item from public.catalog_items c where c.id = new.catalog_item_id;
  if coalesce(item.price_per_line, false) and item.pass_through then
    if new.shop_unit_rate is null or new.shop_unit_rate <= 0
       or not (private.is_cds() or coalesce(current_setting('cds.shop_amount', true), '') = 'on') then
      raise exception 'Misc. hardware is added with the amount from the shop''s invoice'
        using errcode = 'P0001';
    end if;
    new.shop_rate_source := 'manual';
  elsif coalesce(item.price_per_line, false) then
    if not private.is_cds() and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
      raise exception '% is added by CDS with the customer price for this order', item.name
        using errcode = 'P0001';
    end if;
    new.shop_rate_source := case when new.shop_unit_rate is null then 'default' else 'manual' end;
  elsif new.shop_unit_rate is not null and private.is_cds() then
    -- A rate CDS typed in for this line.
    new.shop_rate_source := 'manual';
  else
    select p.amount, p.source into picked_amount, picked_source
      from private.shop_rate_pick(new.catalog_item_id, wo.affiliate_id, wo.customer_id, wo.market, private.today()) p;
    new.shop_unit_rate := picked_amount;
    new.shop_rate_source := coalesce(picked_source, 'default');
  end if;
  if new.added_by is null then
    new.added_by := auth.uid();
  end if;
  return new;
end $$;

create or replace function public.shop_add_part(p_work_order uuid, p_catalog_item uuid, p_qty numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  item public.catalog_items;
  line uuid;
begin
  perform private.shop_can_edit(wo);
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantity must be more than zero' using errcode = 'P0001';
  end if;
  select * into item from public.catalog_items c where c.id = p_catalog_item and c.active and c.shop_selectable;
  if not found then
    raise exception 'Pick a part from the catalog.' using errcode = 'P0001';
  end if;
  if item.category = 'service' then
    raise exception 'Services need an additional authorization request: use Request Additional Authorization.' using errcode = 'P0001';
  end if;
  if item.price_per_line and item.pass_through then
    raise exception '% is added with a description and the amount on your invoice.', item.name using errcode = 'P0001';
  end if;
  if item.price_per_line then
    raise exception '% is priced by CDS on each order: ask CDS to add it.', item.name using errcode = 'P0001';
  end if;
  insert into public.work_order_lines (work_order_id, catalog_item_id, qty, origin)
  values (wo.id, item.id, p_qty, 'shop_added')
  returning id into line;
  perform private.log_event(wo.id, 'line_added', null, null, 'Shop added a part', true);
  return line;
end $$;

create function public.shop_add_pass_through_line(
  p_work_order uuid, p_catalog_item uuid, p_description text, p_amount numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  item public.catalog_items;
  text_in text := btrim(coalesce(p_description, ''));
  line uuid;
begin
  perform private.shop_can_edit(wo);
  select * into item from public.catalog_items c where c.id = p_catalog_item and c.active and c.shop_selectable;
  if not found or not item.price_per_line or not item.pass_through then
    raise exception 'This item is not priced per line: add it as a part.' using errcode = 'P0001';
  end if;
  if text_in = '' then
    raise exception 'Enter a description, for example the bolts and nuts on your invoice.' using errcode = 'P0001';
  end if;
  perform private.check_length(text_in, 500);
  if p_amount is null or p_amount <= 0 or p_amount > 99999.99 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter the amount from your invoice in dollars and cents.' using errcode = 'P0001';
  end if;

  perform set_config('cds.shop_amount', 'on', true);
  insert into public.work_order_lines (work_order_id, catalog_item_id, qty, shop_unit_rate, origin, description)
  values (wo.id, item.id, 1, p_amount, 'shop_added', text_in)
  returning id into line;
  perform set_config('cds.shop_amount', '', true);
  perform private.log_event(wo.id, 'line_added', null, null,
    'Shop added ' || item.name || ': ' || text_in || ' ($' || to_char(p_amount, 'FM999990.00') || ')', true);
  return line;
end $$;

revoke all on function public.shop_add_pass_through_line(uuid, uuid, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.shop_add_pass_through_line(uuid, uuid, text, numeric) to authenticated;
grant execute on function public.shop_add_pass_through_line(uuid, uuid, text, numeric) to service_role;
