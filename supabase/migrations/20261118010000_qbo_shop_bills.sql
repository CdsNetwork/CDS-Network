-- The shop's bill in CDS Inc's QuickBooks (M3, 2026-11-18).
--
-- When a shop completes a work order (and every shop rate is known) the portal creates the
-- shop's bill in QuickBooks: src/lib/qbo/bill.ts builds it, src/lib/qbo/bill-run.ts sends it.
-- Everything here is CDS only; a shop reads none of it.
--
-- 1. qbo_affiliate_vendor: the QuickBooks vendor of each shop, linked by CDS on Admin >
--    QuickBooks mappings (suggested by name). Same shape and rules as qbo_affiliate_class.
--    (affiliate_internal.qb_vendor_id from the first schema was never used and stays empty.)
-- 2. qbo_shop_bills: one row per work order once a bill was attempted: the claim of the run
--    that is creating it, then the QuickBooks bill id, number and total, or the reason it
--    failed (shown on the work order with a Retry). CDS reads it; only the server writes it,
--    through the two functions below (service role only: the automatic run after a shop
--    completes the job has no CDS login, and CDS's button runs on the server after
--    requireCds()).
-- 3. public.qbo_claim_shop_bill(work order): locks the order and takes its one claim before
--    QuickBooks is called. Refused when the order is cancelled, not completed by its shop,
--    done by CDS's own shop, already has a bill, or another run holds a claim younger than 5
--    minutes (an older one has expired and is taken over). Returns the claim id and the
--    QuickBooks request id: "bill-<order id>", or "bill-<order id>-r<n>" after QuickBooks
--    refused n earlier requests outright (nothing was created, and QuickBooks would answer the
--    same id with the stored refusal).
-- 4. public.qbo_finish_shop_bill(work order, claim, outcome, ...): records the result.
--    'created' always records the bill (it exists in QuickBooks), also when the claim expired
--    meanwhile, and copies the id to work_order_internal.qb_bill_id. 'rejected' and 'error'
--    record the reason for the holder of the claim only; 'rejected' moves to the next
--    request id.
-- The account or item every bill line goes to is the app_settings row 'qbo_bill_line'
-- (CDS only, like every app_settings row); without it no bill is created.

create table public.qbo_affiliate_vendor (
  affiliate_id uuid primary key references public.affiliates on delete cascade,
  qbo_vendor_id text not null check (qbo_vendor_id ~ '^[0-9]{1,50}$'),
  qbo_vendor_name text not null check (btrim(qbo_vendor_name) <> '' and char_length(qbo_vendor_name) <= 500),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.qbo_affiliate_vendor enable row level security;
create policy cds_all on public.qbo_affiliate_vendor for all to authenticated
  using ((select private.is_cds())) with check ((select private.is_cds()));
create trigger touch before update on public.qbo_affiliate_vendor
  for each row execute function private.touch_updated_at();
create trigger audit after insert or update or delete on public.qbo_affiliate_vendor
  for each row execute function private.audit();
revoke all on table public.qbo_affiliate_vendor from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.qbo_affiliate_vendor to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_affiliate_vendor to service_role;

create table public.qbo_shop_bills (
  work_order_id uuid primary key references public.work_orders on delete cascade,
  status text not null check (status in ('creating', 'created', 'failed')),
  claim_id uuid,
  claimed_at timestamptz,
  -- QuickBooks refusals so far: the next request id is bill-<id>-r<rejections>.
  rejections integer not null default 0 check (rejections >= 0),
  qb_bill_id text unique check (qb_bill_id is null or char_length(qb_bill_id) <= 50),
  qb_bill_number text check (qb_bill_number is null or char_length(qb_bill_number) <= 50),
  qb_total numeric(12,2),
  qb_vendor_id text check (qb_vendor_id is null or char_length(qb_vendor_id) <= 50),
  error text check (error is null or char_length(error) <= 2000),
  bill_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'created' or qb_bill_id is not null),
  check (status <> 'creating' or (claim_id is not null and claimed_at is not null))
);

alter table public.qbo_shop_bills enable row level security;
create policy cds_read on public.qbo_shop_bills for select to authenticated using ((select private.is_cds()));
create trigger touch before update on public.qbo_shop_bills
  for each row execute function private.touch_updated_at();
revoke all on table public.qbo_shop_bills from public, anon, authenticated, service_role;
grant select on table public.qbo_shop_bills to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_shop_bills to service_role;

create function public.qbo_claim_shop_bill(p_work_order uuid)
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
  if in_house is distinct from false then
    raise exception 'CDS''s own shop does not get a bill.' using errcode = 'P0001';
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

create function public.qbo_finish_shop_bill(
  p_work_order uuid,
  p_claim uuid,
  p_outcome text,
  p_bill_id text default null,
  p_bill_number text default null,
  p_total numeric default null,
  p_vendor_id text default null,
  p_error text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  number text;
begin
  if p_outcome = 'created' then
    if coalesce(btrim(p_bill_id), '') = '' then
      raise exception 'The QuickBooks bill id is missing' using errcode = 'P0001';
    end if;
    update public.qbo_shop_bills b
       set status = 'created', claim_id = null, claimed_at = null, error = null,
           qb_bill_id = btrim(p_bill_id), qb_bill_number = nullif(btrim(p_bill_number), ''),
           qb_total = p_total, qb_vendor_id = nullif(btrim(p_vendor_id), ''), bill_created_at = now()
     where b.work_order_id = p_work_order;
    if not found then
      raise exception 'No shop bill was started for this work order' using errcode = 'P0002';
    end if;
    update public.work_order_internal set qb_bill_id = btrim(p_bill_id) where work_order_id = p_work_order;
    number := coalesce(nullif(btrim(p_bill_number), ''), 'id ' || btrim(p_bill_id));
    perform private.log_event(p_work_order, 'qbo_bill', null, null,
      'QuickBooks bill ' || number || ' created for the shop' || coalesce(' ($' || to_char(p_total, 'FM999999990.00') || ')', ''),
      false);
  elsif p_outcome in ('rejected', 'error') then
    update public.qbo_shop_bills b
       set status = 'failed', claim_id = null, claimed_at = null,
           error = left(coalesce(nullif(btrim(p_error), ''), 'QuickBooks did not create the bill'), 2000),
           rejections = b.rejections + case when p_outcome = 'rejected' then 1 else 0 end
     where b.work_order_id = p_work_order and b.claim_id = p_claim and b.status = 'creating';
  else
    raise exception 'Unknown outcome %', p_outcome using errcode = 'P0001';
  end if;
end $$;

revoke all on function public.qbo_claim_shop_bill(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qbo_claim_shop_bill(uuid) to service_role;
revoke all on function public.qbo_finish_shop_bill(uuid, uuid, text, text, text, numeric, text, text) from public, anon, authenticated, service_role;
grant execute on function public.qbo_finish_shop_bill(uuid, uuid, text, text, text, numeric, text, text) to service_role;
