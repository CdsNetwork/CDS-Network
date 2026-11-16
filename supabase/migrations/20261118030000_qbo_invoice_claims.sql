-- Claim the customer invoice before QuickBooks is called (review 2026-11-16, H3 and H4).
--
-- createQuickBooksInvoice (src/app/cds/work-orders/[id]/actions.ts) read the invoice inputs,
-- called QuickBooks, and only then recorded the invoice; the database locked the inputs only
-- once qb_invoice_id was stored (20261112040000_invoice_any_time.sql). Two problems:
--   H3: the QuickBooks request id was "<order>-r<number of refused rows in integration_sync>".
--       Two overlapping failures of the same attempt logged two rows, so a later request could
--       use a new id while an earlier one was still in QuickBooks: two invoices.
--   H4: lines, prices, customer, PO and tax could change while QuickBooks created the invoice;
--       the invoice built from the older details was then recorded on the changed order.
--
-- 1. public.qbo_invoice_claims: one row per order once an invoice was attempted. CDS can read
--    it; only the functions below (and the service role) write it.
--      state 'idle'         no attempt open; the next one uses request id <order>[-r<attempt>]
--            'sending'      claimed (claim_id, claimed_at): QuickBooks is being called
--            'unconfirmed'  QuickBooks was called but did not answer clearly; the next attempt
--                           uses the same request id, so QuickBooks returns that invoice if it
--                           made one
--            'created'      QuickBooks created invoice qb_invoice_id; recorded on the order by
--                           cds_mark_invoiced (after that the usual invoiced locks apply)
--    attempt counts QuickBooks refusals; snapshot is the fingerprint of the invoice the open
--    request was built from (src/lib/qbo/invoice-claim.ts), kept while QuickBooks may have
--    used it.
-- 2. public.cds_claim_qbo_invoice(order, snapshot) (CDS only): locks the order, refuses an
--    invoiced or cancelled order or one that has its QuickBooks invoice, and takes the claim.
--    A live claim (younger than 5 minutes) is refused ("This invoice is already being created.
--    Refresh in a moment."); an older one is taken over with the same request id, so a crash
--    never blocks invoicing. On the first claim of an order, attempt starts at the number of
--    refusals recorded before this migration (the old request ids). For an order whose invoice
--    was created but not recorded it takes no claim and returns state 'created' with the
--    invoice id and its snapshot, for the app to record it.
-- 3. public.cds_finish_qbo_invoice(order, claim, outcome, invoice id) (CDS only): 'created'
--    always records the invoice (it exists in QuickBooks); 'refused' (QuickBooks answered with
--    a refusal: nothing was created) moves to the next request id; 'unconfirmed' keeps it;
--    'not_sent' (QuickBooks was never called) goes back to what it was. Except 'created', only
--    the holder of the live claim can finish it, so a late or repeated report changes nothing.
-- 4. Locks: while a claim is live, while QuickBooks has not confirmed (also after a crash), and
--    while an invoice is created but not recorded, signed-in callers cannot change the invoice
--    inputs: customer lines (added, removed, item, quantity, description), customer prices and
--    tax classes, the order's customer, location, market, PO and unit, the tax settings, and
--    cannot cancel the order. The service role (intake, fixtures) is not stopped, like the
--    invoiced locks. Deleting the order is not stopped.
-- Grants: tests/rls/grants.snapshot.json lists the new table and functions.

-- ---------------------------------------------------------------- 1. claims

create table public.qbo_invoice_claims (
  work_order_id uuid primary key references public.work_orders on delete cascade,
  state text not null check (state in ('idle', 'sending', 'unconfirmed', 'created')),
  attempt integer not null default 0 check (attempt >= 0),
  claim_id uuid,
  claimed_at timestamptz,
  claimed_by uuid references public.profiles on delete set null,
  -- A request with the current request id may have reached QuickBooks (an unclear answer, or a
  -- claim abandoned while sending). Cleared by a refusal.
  maybe_sent boolean not null default false,
  snapshot text check (snapshot is null or char_length(snapshot) <= 200),
  qb_invoice_id text check (qb_invoice_id is null or char_length(qb_invoice_id) <= 50),
  updated_at timestamptz not null default now(),
  check (state <> 'sending' or (claim_id is not null and claimed_at is not null)),
  check (state <> 'created' or qb_invoice_id is not null)
);

alter table public.qbo_invoice_claims enable row level security;
create policy cds_read on public.qbo_invoice_claims for select to authenticated using ((select private.is_cds()));
create trigger touch before update on public.qbo_invoice_claims
  for each row execute function private.touch_updated_at();
revoke all on table public.qbo_invoice_claims from public, anon, authenticated, service_role;
grant select on table public.qbo_invoice_claims to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_invoice_claims to service_role;

-- ---------------------------------------------------------------- 2. claim

create function public.cds_claim_qbo_invoice(p_work_order uuid, p_snapshot text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
  invoice text;
  c public.qbo_invoice_claims;
  sent boolean;
begin
  perform private.require_cds();
  perform private.check_length(p_snapshot, 200);
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
  select i.qb_invoice_id into invoice from public.work_order_internal i where i.work_order_id = wo.id;
  if invoice is not null then
    raise exception 'This work order already has QuickBooks invoice %', invoice using errcode = 'P0001';
  end if;

  select * into c from public.qbo_invoice_claims where work_order_id = wo.id for update;
  if not found then
    -- Before claims, each refusal row moved the request id on: start after those ids.
    insert into public.qbo_invoice_claims (work_order_id, state, attempt)
    values (wo.id, 'idle', (
      select count(*) from public.integration_sync s
       where s.system = 'quickbooks' and s.entity = 'invoice' and s.entity_id = wo.id and s.status = 'rejected'))
    returning * into c;
  end if;

  if c.state = 'created' then
    return jsonb_build_object('state', 'created', 'qb_invoice_id', c.qb_invoice_id, 'snapshot', c.snapshot);
  end if;
  if c.state = 'sending' and c.claimed_at > now() - interval '5 minutes' then
    raise exception 'This invoice is already being created. Refresh in a moment.' using errcode = 'P0001';
  end if;

  -- An unconfirmed attempt, or a claim abandoned while sending: QuickBooks may have the
  -- request, so its details stay the ones to compare with.
  sent := c.maybe_sent or c.state in ('sending', 'unconfirmed');
  update public.qbo_invoice_claims
     set state = 'sending', claim_id = gen_random_uuid(), claimed_at = now(), claimed_by = auth.uid(),
         maybe_sent = sent,
         snapshot = case when sent then coalesce(c.snapshot, p_snapshot) else p_snapshot end
   where work_order_id = wo.id
  returning * into c;

  return jsonb_build_object(
    'state', 'sending',
    'claim_id', c.claim_id,
    'attempt', c.attempt,
    'request_id', wo.id::text || case when c.attempt > 0 then '-r' || c.attempt::text else '' end,
    'snapshot', c.snapshot
  );
end $$;

-- ---------------------------------------------------------------- 3. finish

create function public.cds_finish_qbo_invoice(p_work_order uuid, p_claim uuid, p_outcome text, p_qb_invoice_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_cds();
  if p_outcome = 'created' then
    if coalesce(btrim(p_qb_invoice_id), '') = '' then
      raise exception 'The QuickBooks invoice id is missing' using errcode = 'P0001';
    end if;
    perform private.check_length(btrim(p_qb_invoice_id), 50);
    -- Recorded whoever holds the claim: the invoice exists in QuickBooks.
    insert into public.qbo_invoice_claims as c (work_order_id, state, qb_invoice_id)
    values (p_work_order, 'created', btrim(p_qb_invoice_id))
    on conflict (work_order_id) do update
       set state = 'created', qb_invoice_id = excluded.qb_invoice_id, claim_id = null, claimed_at = null;
  elsif p_outcome = 'refused' then
    update public.qbo_invoice_claims c
       set state = 'idle', attempt = c.attempt + 1, claim_id = null, claimed_at = null, snapshot = null, maybe_sent = false
     where c.work_order_id = p_work_order and c.claim_id = p_claim and c.state = 'sending';
  elsif p_outcome = 'unconfirmed' then
    update public.qbo_invoice_claims c
       set state = 'unconfirmed', claim_id = null, claimed_at = null, maybe_sent = true
     where c.work_order_id = p_work_order and c.claim_id = p_claim and c.state = 'sending';
  elsif p_outcome = 'not_sent' then
    -- Back to what it was: unconfirmed when an earlier request may be in QuickBooks.
    update public.qbo_invoice_claims c
       set state = case when c.maybe_sent then 'unconfirmed' else 'idle' end,
           claim_id = null, claimed_at = null,
           snapshot = case when c.maybe_sent then c.snapshot else null end
     where c.work_order_id = p_work_order and c.claim_id = p_claim and c.state = 'sending';
  else
    raise exception 'Unknown outcome %', p_outcome using errcode = 'P0001';
  end if;
end $$;

revoke all on function public.cds_claim_qbo_invoice(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.cds_claim_qbo_invoice(uuid, text) to authenticated;
grant execute on function public.cds_claim_qbo_invoice(uuid, text) to service_role;
revoke all on function public.cds_finish_qbo_invoice(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.cds_finish_qbo_invoice(uuid, uuid, text, text) to authenticated;
grant execute on function public.cds_finish_qbo_invoice(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------- 4. locks

-- Why the invoice inputs of the order cannot change now, or null. Null once the invoice is
-- recorded on the order (the invoiced locks apply then) and for an order being deleted.
create function private.invoice_claim_block(p_work_order uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
           when c.state = 'sending' and c.claimed_at > now() - interval '5 minutes'
             then 'The invoice for this work order is being created in QuickBooks. Try again in a moment.'
           when c.state in ('sending', 'unconfirmed')
             then 'QuickBooks has not confirmed the invoice for this work order yet. Click Create QuickBooks invoice again, then make the change.'
           when c.state = 'created'
             then 'The QuickBooks invoice for this work order was created but is not recorded yet. Click Create QuickBooks invoice to record it.'
         end
    from public.qbo_invoice_claims c
    join public.work_orders w on w.id = c.work_order_id
    left join public.work_order_internal i on i.work_order_id = c.work_order_id
   where c.work_order_id = p_work_order and i.qb_invoice_id is null
$$;
revoke all on function private.invoice_claim_block(uuid) from public;

-- One trigger function for every table with invoice inputs. The trigger arguments name the
-- columns that are inputs: an update that changes none of them passes. Adding or removing a
-- row is a change. On work_orders, cancelling is refused too.
create function private.invoice_inputs_locked() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  o jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  changed boolean := tg_op <> 'UPDATE';
  col text;
  wo uuid;
  reason text;
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' then
    foreach col in array tg_argv loop
      if n -> col is distinct from o -> col then
        changed := true;
        exit;
      end if;
    end loop;
    if tg_table_name = 'work_orders' and n ->> 'status' = 'cancelled' and o ->> 'status' <> 'cancelled' then
      changed := true;
    end if;
  end if;
  if not changed then
    return coalesce(new, old);
  end if;
  wo := (coalesce(n, o) ->> case when tg_table_name = 'work_orders' then 'id' else 'work_order_id' end)::uuid;
  -- Waits for a claim being taken on this order (it locks the order), and makes a claim wait
  -- until this change is committed, so the claim's reading of the order includes it.
  perform 1 from public.work_orders w where w.id = wo for key share;
  reason := private.invoice_claim_block(wo);
  if reason is not null then
    raise exception '%', reason using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function private.invoice_inputs_locked() from public;

create trigger invoice_inputs_locked
  before insert or delete or update on public.work_order_lines
  for each row execute function private.invoice_inputs_locked('catalog_item_id', 'qty', 'description');
create trigger invoice_inputs_locked
  before insert or delete or update on public.work_order_line_pricing
  for each row execute function private.invoice_inputs_locked('customer_unit_price', 'tax_class');
create trigger invoice_inputs_locked
  before update on public.work_orders
  for each row execute function private.invoice_inputs_locked('customer_id', 'location_id', 'market', 'po_number', 'unit_number');
create trigger invoice_inputs_locked
  before update on public.work_order_internal
  for each row execute function private.invoice_inputs_locked('tax_rate', 'tax_parts', 'tax_labor', 'tax_shipping');
