-- Shop bills for CDS's in-house shop once it is linked to a vendor (Ashley, CDS, 2026-11-19:
-- the in-house shop is used only for filter sales through CDS's vendor GESi; CDS wants that
-- vendor linked to the shop so the bill is created and pushed to QuickBooks like any shop's).
--
-- The bill of an in-house order is built like any shop's (src/lib/qbo/bill.ts): its lines are
-- the order's in-house line amounts (work_order_lines.shop_unit_rate, which on the in-house
-- shop is CDS's own cost, 20261110030000_in_house_shop.sql), and it has no shipping deduction
-- (public.work_order_shop_deductions never has a row for the in-house shop). Nothing here
-- changes amounts, financials or margins.
--
-- 1. qbo_affiliate_vendor.linked_at: when the shop was linked to its vendor (default now()).
--    Changing the vendor later (the admin upsert) keeps it; removing the link and linking
--    again starts a new time. In-house orders completed before then get no automatic bill
--    (CDS may have entered those vendor bills by hand); CDS can still create one with the
--    button on the work order. Regular shops keep today's rule (bills turned on decides).
--    Existing rows get the time of this migration, which only matters for the in-house shop.
--    CDS only, like the rest of the table (cds_all policy); no grant changes (table grants).
-- 2. public.qbo_claim_shop_bill: same as 20261118010000_qbo_shop_bills.sql, except that an
--    in-house order may be claimed when the in-house shop is linked to a QuickBooks vendor.
--    Without a link it is refused as before, now saying why; an order with no shop at all is
--    refused with its own message. Grants unchanged (create or replace keeps them).

-- ---------------------------------------------------------------- 1. linked_at

alter table public.qbo_affiliate_vendor add column linked_at timestamptz not null default now();
comment on column public.qbo_affiliate_vendor.linked_at is
  'When CDS linked the shop to this QuickBooks vendor; kept when the vendor is changed. In-house orders completed before it get no automatic bill (src/lib/qbo/bill.ts).';

-- ---------------------------------------------------------------- 2. claim

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
