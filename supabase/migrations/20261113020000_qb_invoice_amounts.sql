-- The sales tax and total QuickBooks calculated for the customer invoice (Sarah, CDS dispatch,
-- 2026-11-13: WO-102096, ship-to Harmony, PA, showed "Sales tax (0%) $0.00" although
-- QuickBooks invoice 40126 charged PA sales tax). QuickBooks Automated Sales Tax is the source
-- of truth; the portal's tax_rates table only gives an estimate before the invoice exists.
--
-- 1. work_order_internal.qb_tax_total and qb_total (nullable): Invoice.TxnTaxDetail.TotalTax and
--    Invoice.TotalAmt of the QuickBooks invoice. Empty for invoices recorded before this
--    migration and when QuickBooks returned no amount. Same access as the rest of the table
--    (CDS only, policy cds_all).
-- 2. public.cds_mark_invoiced takes them as two optional arguments (default null), so the call
--    with the original three arguments works as before. Recording the same invoice again fills
--    amounts that are still empty. Otherwise as in 20261112040000_invoice_any_time.sql.
--    The function's signature changes, so it is dropped and created again with its grants
--    (tests/rls/grants.snapshot.json updated).

-- ---------------------------------------------------------------- 1. columns

alter table public.work_order_internal
  add column qb_tax_total numeric(12,2) check (qb_tax_total >= 0),
  add column qb_total numeric(12,2) check (qb_total >= 0);

-- ---------------------------------------------------------------- 2. record the invoice

drop function public.cds_mark_invoiced(uuid, text, text);

create function public.cds_mark_invoiced(
  p_work_order uuid,
  p_qb_invoice_id text,
  p_qb_invoice_number text,
  p_qb_tax_total numeric default null,
  p_qb_total numeric default null
)
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
  if p_qb_tax_total < 0 or p_qb_total < 0 then
    raise exception 'The QuickBooks invoice amounts cannot be negative' using errcode = 'P0001';
  end if;

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
  -- The same invoice again on an order the shop is still working on: already recorded; only
  -- amounts that are still empty are filled.
  if existing is not null and new_status = wo.status then
    update public.work_order_internal
       set qb_tax_total = coalesce(qb_tax_total, round(p_qb_tax_total, 2)),
           qb_total = coalesce(qb_total, round(p_qb_total, 2))
     where work_order_id = wo.id and (p_qb_tax_total is not null or p_qb_total is not null);
    return;
  end if;

  update public.work_order_internal
     set qb_invoice_id = invoice_id,
         qb_invoice_number = nullif(btrim(p_qb_invoice_number), ''),
         qb_tax_total = coalesce(round(p_qb_tax_total, 2), qb_tax_total),
         qb_total = coalesce(round(p_qb_total, 2), qb_total),
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

revoke all on function public.cds_mark_invoiced(uuid, text, text, numeric, numeric) from public, anon, authenticated, service_role;
grant execute on function public.cds_mark_invoiced(uuid, text, text, numeric, numeric) to authenticated;
grant execute on function public.cds_mark_invoiced(uuid, text, text, numeric, numeric) to service_role;
