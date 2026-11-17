-- One order across 2 shops (CDS, 2026-11-17, milestone M4): two linked work orders get ONE
-- customer invoice in QuickBooks with the lines of both. Each shop still gets its own bill
-- (qbo_shop_bills, unchanged). Work orders that are not linked are invoiced as before.
--
-- Example: PO 0899253330, the filters failed at the local shop, so the remans ship from a
-- second shop. CDS links the two work orders (public.work_order_links,
-- 20261119010000_linked_work_order.sql); the invoice is created from either page.
--
-- The pair: a work order and the one it is linked to (either side may hold the link row, or
-- both). The first work order of the pair is the one with the lowest WO number; it owns the
-- invoice claim (20261118030000_qbo_invoice_claims.sql) and its request id. A group of more
-- than two linked work orders gets no combined invoice.
--
-- 1. qbo_invoice_claims.linked_work_order_id: the other work order the claimed invoice covers
--    (null for an invoice of one work order). CDS reads it like the rest of the table.
-- 2. private.linked_group(order, skip): the work orders linked to the order, directly or
--    through the other one, sorted (link rows held by `skip` are left out).
-- 3. public.cds_claim_qbo_invoice(order, snapshot, linked default null): as before, for the
--    pair when the order is linked. p_linked is the other work order the app built the invoice
--    for (null: this order alone); the call is refused when the links in the database say
--    otherwise, so an invoice built for one order is never sent for a pair or the other way
--    round. Both orders are locked; both must be neither invoiced nor cancelled nor have a
--    QuickBooks invoice, and neither may have an invoice of its own still open in QuickBooks.
--    The claim is taken on the first work order. Returns as before, plus work_order_id (the
--    order the claim is on: cds_finish_qbo_invoice is called with it) and
--    linked_work_order_id. The old two argument function is dropped.
-- 4. private.invoice_claim_block: an open claim of the pair locks the invoice inputs of both.
-- 5. public.cds_mark_invoiced_linked(first, other, invoice id, number, tax, total): records the
--    created invoice on both work orders at once (each as public.cds_mark_invoiced does: a
--    done order moves to Invoiced, the other moves when its shop completes it), only for the
--    invoice the pair's claim has as created. Logs a CDS-only event on both naming both.
-- 6. QuickBooks invoice id and number were unique per work order (core schema). Two linked
--    work orders now record the same invoice, so the unique constraints are replaced by a
--    trigger: an id or number recorded on another work order is refused (as before), except
--    on the other work order of the pair whose claim created that invoice. A transaction lock
--    per id and number keeps two recordings at the same moment apart.
-- 7. Links (signed-in callers; the service role and deleting a work order are not stopped):
--      * a link of a pair whose invoice is being created, not confirmed or recorded cannot be
--        removed or moved;
--      * a work order that has a QuickBooks invoice or is invoiced cannot be linked;
--      * a work order whose own invoice is being created cannot be linked;
--      * a pair cannot take a third work order.
--    The work orders are locked as the claim locks them, so linking and claiming never
--    overlap.
-- Grants: tests/rls/grants.snapshot.json (claim function signature, new function).

-- ---------------------------------------------------------------- 1. claim column

alter table public.qbo_invoice_claims
  add column linked_work_order_id uuid references public.work_orders on delete set null;
create index qbo_invoice_claims_linked on public.qbo_invoice_claims (linked_work_order_id) where linked_work_order_id is not null;

comment on column public.qbo_invoice_claims.linked_work_order_id is
  'The other work order the claimed QuickBooks invoice covers (one invoice for two linked work orders); null for an invoice of this work order alone.';

-- ---------------------------------------------------------------- 2. linked group

create function private.linked_group(p_work_order uuid, p_skip uuid default null) returns uuid[]
language sql stable security definer set search_path = '' as $$
  with recursive g(id) as (
    select p_work_order
    union
    select case when l.work_order_id = g.id then l.linked_work_order_id else l.work_order_id end
      from g
      join public.work_order_links l on l.work_order_id = g.id or l.linked_work_order_id = g.id
     where p_skip is null or l.work_order_id <> p_skip
  )
  select array_agg(id order by id) from g
$$;
revoke all on function private.linked_group(uuid, uuid) from public;

-- ---------------------------------------------------------------- 3. claim

drop function public.cds_claim_qbo_invoice(uuid, text);

create function public.cds_claim_qbo_invoice(p_work_order uuid, p_snapshot text, p_linked uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  grp uuid[];
  wo public.work_orders;
  partner public.work_orders;
  owner_id uuid;
  other_id uuid;
  invoice text;
  c public.qbo_invoice_claims;
  pc public.qbo_invoice_claims;
  sent boolean;
begin
  perform private.require_cds();
  perform private.check_length(p_snapshot, 200);
  -- Lock the order and the orders linked to it (in id order), then check the links did not
  -- change meanwhile: linking locks the same rows (section 7).
  grp := private.linked_group(p_work_order);
  perform 1 from public.work_orders w where w.id = any(grp) order by w.id for update;
  select * into wo from public.work_orders where id = p_work_order for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if grp is distinct from private.linked_group(p_work_order) then
    raise exception 'The linked work orders changed. Reload the page and try again.' using errcode = 'P0001';
  end if;
  if cardinality(grp) > 2 then
    raise exception 'WO-% is linked to more than one other work order. One QuickBooks invoice covers two linked work orders: remove the extra link first.', wo.wo_number
      using errcode = 'P0001';
  end if;
  other_id := (select x from unnest(grp) x where x <> wo.id);
  if other_id is distinct from p_linked then
    if p_linked is null then
      raise exception 'WO-% is linked to WO-%, so the invoice covers both. Reload the page and try again.',
        wo.wo_number, (select w.wo_number from public.work_orders w where w.id = other_id)
        using errcode = 'P0001';
    end if;
    raise exception 'The linked work orders changed. Reload the page and try again.' using errcode = 'P0001';
  end if;

  if wo.status = 'invoiced' then
    raise exception 'This work order is already invoiced' using errcode = 'P0001';
  end if;
  if wo.status = 'cancelled' then
    raise exception 'A cancelled work order cannot be invoiced' using errcode = 'P0001';
  end if;
  select i.qb_invoice_id into invoice from public.work_order_internal i where i.work_order_id = wo.id;
  if invoice is not null then
    raise exception 'This work order already has QuickBooks invoice %', invoice using errcode = 'P0001';
  end if;

  owner_id := wo.id;
  if other_id is not null then
    select * into partner from public.work_orders where id = other_id;
    if partner.status = 'cancelled' then
      raise exception 'Linked work order WO-% is cancelled. Remove the link to invoice this work order on its own.', partner.wo_number
        using errcode = 'P0001';
    end if;
    select i.qb_invoice_id into invoice from public.work_order_internal i where i.work_order_id = partner.id;
    if invoice is not null then
      raise exception 'Linked work order WO-% already has QuickBooks invoice %. Remove the link to invoice this work order on its own.', partner.wo_number, invoice
        using errcode = 'P0001';
    end if;
    if partner.status = 'invoiced' then
      raise exception 'Linked work order WO-% is already invoiced. Remove the link to invoice this work order on its own.', partner.wo_number
        using errcode = 'P0001';
    end if;
    if partner.wo_number < wo.wo_number then
      owner_id := partner.id;
      other_id := wo.id;
    end if;
    -- The other order's own claim: an invoice of it alone may be in QuickBooks.
    select * into pc from public.qbo_invoice_claims where work_order_id = other_id for update;
    if found and (pc.state <> 'idle' or pc.maybe_sent) and pc.linked_work_order_id is null then
      raise exception 'An invoice for WO-% on its own was started in QuickBooks before the link. Remove the link and click Create QuickBooks invoice on WO-% to finish it.',
        (select w.wo_number from public.work_orders w where w.id = other_id), (select w.wo_number from public.work_orders w where w.id = other_id)
        using errcode = 'P0001';
    end if;
  end if;

  select * into c from public.qbo_invoice_claims where work_order_id = owner_id for update;
  if not found then
    -- Before claims, each refusal row moved the request id on: start after those ids.
    insert into public.qbo_invoice_claims (work_order_id, state, attempt, linked_work_order_id)
    values (owner_id, 'idle', (
      select count(*) from public.integration_sync s
       where s.system = 'quickbooks' and s.entity = 'invoice' and s.entity_id = owner_id and s.status = 'rejected'), other_id)
    returning * into c;
  end if;

  -- An attempt still open for something else than this pair (or this order alone).
  if (c.state <> 'idle' or c.maybe_sent) and c.linked_work_order_id is distinct from other_id then
    if c.linked_work_order_id is null then
      raise exception 'An invoice for WO-% on its own was started in QuickBooks before the link. Remove the link and click Create QuickBooks invoice on WO-% to finish it.',
        (select w.wo_number from public.work_orders w where w.id = owner_id), (select w.wo_number from public.work_orders w where w.id = owner_id)
        using errcode = 'P0001';
    end if;
    raise exception 'An invoice for WO-% and WO-% was started in QuickBooks. Link the two work orders again and click Create QuickBooks invoice to finish it.',
      (select w.wo_number from public.work_orders w where w.id = owner_id), (select w.wo_number from public.work_orders w where w.id = c.linked_work_order_id)
      using errcode = 'P0001';
  end if;

  if c.state = 'created' then
    return jsonb_build_object('state', 'created', 'qb_invoice_id', c.qb_invoice_id, 'snapshot', c.snapshot,
      'work_order_id', owner_id, 'linked_work_order_id', other_id);
  end if;
  if c.state = 'sending' and c.claimed_at > now() - interval '5 minutes' then
    raise exception 'This invoice is already being created. Refresh in a moment.' using errcode = 'P0001';
  end if;

  -- An unconfirmed attempt, or a claim abandoned while sending: QuickBooks may have the
  -- request, so its details stay the ones to compare with.
  sent := c.maybe_sent or c.state in ('sending', 'unconfirmed');
  update public.qbo_invoice_claims
     set state = 'sending', claim_id = gen_random_uuid(), claimed_at = now(), claimed_by = auth.uid(),
         maybe_sent = sent, linked_work_order_id = other_id,
         snapshot = case when sent then coalesce(c.snapshot, p_snapshot) else p_snapshot end
   where work_order_id = owner_id
  returning * into c;

  return jsonb_build_object(
    'state', 'sending',
    'claim_id', c.claim_id,
    'attempt', c.attempt,
    'request_id', owner_id::text || case when c.attempt > 0 then '-r' || c.attempt::text else '' end,
    'snapshot', c.snapshot,
    'work_order_id', owner_id,
    'linked_work_order_id', other_id
  );
end $$;

revoke all on function public.cds_claim_qbo_invoice(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_claim_qbo_invoice(uuid, text, uuid) to authenticated;
grant execute on function public.cds_claim_qbo_invoice(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------- 4. locks for both orders

-- As in 20261118030000_qbo_invoice_claims.sql, also for the claim of the pair held by the
-- other (first) work order.
create or replace function private.invoice_claim_block(p_work_order uuid) returns text
language sql stable security definer set search_path = '' as $$
  select r from (
    select case
             when c.state = 'sending' and c.claimed_at > now() - interval '5 minutes'
               then 'The invoice for this work order is being created in QuickBooks. Try again in a moment.'
             when c.state in ('sending', 'unconfirmed')
               then 'QuickBooks has not confirmed the invoice for this work order yet. Click Create QuickBooks invoice again, then make the change.'
             when c.state = 'created'
               then 'The QuickBooks invoice for this work order was created but is not recorded yet. Click Create QuickBooks invoice to record it.'
           end as r
      from public.qbo_invoice_claims c
      join public.work_orders w on w.id = p_work_order
      left join public.work_order_internal i on i.work_order_id = p_work_order
     where (c.work_order_id = p_work_order or c.linked_work_order_id = p_work_order) and i.qb_invoice_id is null
  ) s
  where r is not null
  limit 1
$$;

-- ---------------------------------------------------------------- 6. one invoice per order, or per pair

alter table public.work_order_internal drop constraint work_order_internal_qb_invoice_id_key;
alter table public.work_order_internal drop constraint work_order_internal_qb_invoice_number_key;
create index work_order_internal_qb_invoice_id on public.work_order_internal (qb_invoice_id) where qb_invoice_id is not null;
create index work_order_internal_qb_invoice_number on public.work_order_internal (qb_invoice_number) where qb_invoice_number is not null;

create function private.qb_invoice_once() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.qb_invoice_id, new.qb_invoice_number) is not distinct from (old.qb_invoice_id, old.qb_invoice_number) then
    return new;
  end if;
  if new.qb_invoice_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('qb_invoice_id:' || new.qb_invoice_id, 0));
  end if;
  if new.qb_invoice_number is not null then
    perform pg_advisory_xact_lock(hashtextextended('qb_invoice_number:' || new.qb_invoice_number, 0));
  end if;
  if exists (
    select 1 from public.work_order_internal i
     where i.work_order_id <> new.work_order_id
       and (i.qb_invoice_id = new.qb_invoice_id or i.qb_invoice_number = new.qb_invoice_number)
       -- the other work order of the pair whose claim created this invoice
       and not (
         i.qb_invoice_id = new.qb_invoice_id
         and i.qb_invoice_number is not distinct from new.qb_invoice_number
         and exists (
           select 1 from public.qbo_invoice_claims c
            where c.state = 'created' and c.qb_invoice_id = new.qb_invoice_id
              and ((c.work_order_id = i.work_order_id and c.linked_work_order_id = new.work_order_id)
                or (c.work_order_id = new.work_order_id and c.linked_work_order_id = i.work_order_id))))
  ) then
    raise exception 'QuickBooks invoice % is already recorded on another work order', coalesce(new.qb_invoice_number, new.qb_invoice_id)
      using errcode = '23505';
  end if;
  return new;
end $$;
revoke all on function private.qb_invoice_once() from public;

create trigger qb_invoice_once
  before insert or update of qb_invoice_id, qb_invoice_number on public.work_order_internal
  for each row execute function private.qb_invoice_once();

-- ---------------------------------------------------------------- 5. record on both

create function public.cds_mark_invoiced_linked(
  p_work_order uuid,
  p_linked uuid,
  p_qb_invoice_id text,
  p_qb_invoice_number text,
  p_qb_tax_total numeric default null,
  p_qb_total numeric default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a public.work_orders;
  b public.work_orders;
  name text;
  msg text;
begin
  perform private.require_cds();
  -- Both orders locked in id order, as the claim locks them.
  perform 1 from public.work_orders w where w.id in (p_work_order, p_linked) order by w.id for update;
  if not exists (
    select 1 from public.qbo_invoice_claims c
     where c.work_order_id = p_work_order and c.linked_work_order_id = p_linked
       and c.state = 'created' and c.qb_invoice_id = btrim(p_qb_invoice_id)
  ) then
    raise exception 'This QuickBooks invoice was not created for these linked work orders. Click Create QuickBooks invoice again.' using errcode = 'P0001';
  end if;
  perform public.cds_mark_invoiced(p_work_order, p_qb_invoice_id, p_qb_invoice_number, p_qb_tax_total, p_qb_total);
  perform public.cds_mark_invoiced(p_linked, p_qb_invoice_id, p_qb_invoice_number, p_qb_tax_total, p_qb_total);
  select * into a from public.work_orders where id = p_work_order;
  select * into b from public.work_orders where id = p_linked;
  name := coalesce(nullif(btrim(p_qb_invoice_number), ''), 'id ' || btrim(p_qb_invoice_id));
  msg := 'QuickBooks invoice ' || name || ' covers WO-' || a.wo_number || ' and WO-' || b.wo_number || ' (linked work orders, one customer invoice)';
  perform private.log_event(a.id, 'invoice', null, null, msg, false);
  perform private.log_event(b.id, 'invoice', null, null, msg, false);
end $$;

revoke all on function public.cds_mark_invoiced_linked(uuid, uuid, text, text, numeric, numeric) from public, anon, authenticated, service_role;
grant execute on function public.cds_mark_invoiced_linked(uuid, uuid, text, text, numeric, numeric) to authenticated;
grant execute on function public.cds_mark_invoiced_linked(uuid, uuid, text, text, numeric, numeric) to service_role;

-- ---------------------------------------------------------------- 7. links

create function private.work_order_links_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  x uuid;
  n bigint;
  st public.wo_status;
  inv text;
  c public.qbo_invoice_claims;
  grp uuid[];
  first_wo bigint;
  other_wo bigint;
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  -- The same rows the invoice claim locks.
  perform 1 from public.work_orders w
   where w.id in (old.work_order_id, old.linked_work_order_id, new.work_order_id, new.linked_work_order_id)
   order by w.id for update;

  -- Removing or moving a link: not while the pair's invoice is started or recorded. A link
  -- removed because a work order is deleted is not stopped.
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.linked_work_order_id is distinct from old.linked_work_order_id) then
    if exists (select 1 from public.work_orders w where w.id = old.work_order_id)
       and exists (select 1 from public.work_orders w where w.id = old.linked_work_order_id) then
      select * into c from public.qbo_invoice_claims q
       where ((q.work_order_id = old.work_order_id and q.linked_work_order_id = old.linked_work_order_id)
           or (q.work_order_id = old.linked_work_order_id and q.linked_work_order_id = old.work_order_id))
         and (q.state <> 'idle' or q.maybe_sent);
      if found then
        select w.wo_number into first_wo from public.work_orders w where w.id = c.work_order_id;
        select w.wo_number into other_wo from public.work_orders w where w.id = c.linked_work_order_id;
        if c.state = 'created' then
          select coalesce(i.qb_invoice_number, c.qb_invoice_id) into inv from public.work_order_internal i where i.work_order_id = c.work_order_id;
          raise exception 'WO-% and WO-% share QuickBooks invoice %, so the link cannot be removed.', first_wo, other_wo, coalesce(inv, c.qb_invoice_id)
            using errcode = 'P0001';
        end if;
        raise exception 'The QuickBooks invoice for WO-% and WO-% is being created, so the link cannot be removed. Click Create QuickBooks invoice to finish it first.', first_wo, other_wo
          using errcode = 'P0001';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  -- Adding a link. Nothing changes when the two are linked already (the same link again, or
  -- the other way round).
  if new.linked_work_order_id = any(private.linked_group(new.work_order_id, new.work_order_id)) then
    return new;
  end if;
  foreach x in array array[new.work_order_id, new.linked_work_order_id] loop
    select w.wo_number, w.status, coalesce(i.qb_invoice_number, i.qb_invoice_id) into n, st, inv
      from public.work_orders w left join public.work_order_internal i on i.work_order_id = w.id
     where w.id = x;
    if not found then
      continue;
    end if;
    if inv is not null then
      raise exception 'WO-% already has QuickBooks invoice %, so it cannot be linked: linked work orders share one customer invoice.', n, inv
        using errcode = 'P0001';
    end if;
    if st = 'invoiced' then
      raise exception 'WO-% is already invoiced, so it cannot be linked: linked work orders share one customer invoice.', n
        using errcode = 'P0001';
    end if;
    if exists (select 1 from public.qbo_invoice_claims q
                where (q.work_order_id = x or q.linked_work_order_id = x) and (q.state <> 'idle' or q.maybe_sent)) then
      raise exception 'A QuickBooks invoice for WO-% is being created, so it cannot be linked now. Click Create QuickBooks invoice on it to finish it first.', n
        using errcode = 'P0001';
    end if;
  end loop;
  -- At most two work orders per invoice. The link row of new.work_order_id is replaced, so
  -- it does not count.
  foreach x in array array[new.work_order_id, new.linked_work_order_id] loop
    grp := private.linked_group(x, new.work_order_id);
    if cardinality(grp) > 1 then
      select w.wo_number into n from public.work_orders w where w.id = x;
      select w.wo_number into other_wo from public.work_orders w where w.id = (select y from unnest(grp) y where y <> x limit 1);
      raise exception 'WO-% is already linked to WO-%. One QuickBooks invoice covers two linked work orders: remove that link first.', n, other_wo
        using errcode = 'P0001';
    end if;
  end loop;
  return new;
end $$;
revoke all on function private.work_order_links_guard() from public;

create trigger invoice_guard
  before insert or update or delete on public.work_order_links
  for each row execute function private.work_order_links_guard();

comment on table public.work_order_links is
  'CDS only: a work order linked to another work order of the same customer order (for example the part sent to a second shop). Shown on both work order pages. The two get one customer invoice in QuickBooks (20261119080000_combined_invoice.sql); each shop keeps its own bill.';
