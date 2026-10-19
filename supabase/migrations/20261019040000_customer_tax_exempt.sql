-- BUG-M2-9: a tax exempt customer (customer_billing.tax_exempt) is never charged sales tax.
--
-- The QuickBooks invoice already marks every line of an exempt customer non-taxable, but
-- the order's own tax settings (work_order_internal) still started from the state table, so
-- the work order page showed sales tax for Ryder. The app now applies the same rule on the
-- page (src/lib/tax.ts). This migration keeps the stored settings consistent with it:
--
--   1. private.tax_follows_exemption (before insert or update on work_order_internal): for an
--      exempt customer's order that is not invoiced, the rate is 0, no class is taxed and the
--      source is 'customer_exempt', whatever the caller wrote (Create Work Order form, email
--      intake, Save Tax Settings).
--   2. private.exemption_changed (after insert or update on customer_billing): when a
--      customer becomes exempt, its open orders lose their tax; when the exemption ends,
--      orders that had no tax only because of it get the state's starting tax back (as a new
--      order would). Invoiced orders never change.
--   3. Existing open orders of exempt customers are brought in line.

create function private.starting_tax(p_location uuid)
returns table (rate numeric, taxes_parts boolean, taxes_labor boolean, taxes_shipping boolean, jurisdiction text, source text)
language sql stable security definer set search_path = '' as $$
  -- The state's rate for the order's location, as the Create Work Order form and email
  -- intake set it; otherwise the column defaults.
  select coalesce(t.rate, 0), coalesce(t.taxes_parts, true), coalesce(t.taxes_labor, false),
         coalesce(t.taxes_shipping, true),
         case when t.id is not null then l.region end,
         case when t.id is not null then 'state_fallback' end
    from (select 1) one
    left join public.customer_locations l on l.id = p_location
    left join public.tax_rates t on t.market = l.market and t.region = l.region and t.postal_code is null
$$;
revoke all on function private.starting_tax(uuid) from public;

create function private.tax_follows_exemption() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
begin
  select * into wo from public.work_orders where id = new.work_order_id;
  if wo.status = 'invoiced' then
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
revoke all on function private.tax_follows_exemption() from public;

create trigger work_order_internal_tax_follows_exemption
  before insert or update on public.work_order_internal
  for each row execute function private.tax_follows_exemption();

create function private.exemption_changed() returns trigger
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
     where w.id = i.work_order_id and w.customer_id = new.customer_id and w.status <> 'invoiced';
  elsif tg_op = 'UPDATE' then
    update public.work_order_internal i
       set tax_rate = s.rate, tax_parts = s.taxes_parts, tax_labor = s.taxes_labor,
           tax_shipping = s.taxes_shipping, tax_jurisdiction = coalesce(s.jurisdiction, i.tax_jurisdiction),
           tax_source = s.source
      from public.work_orders w
      cross join lateral private.starting_tax(w.location_id) s
     where w.id = i.work_order_id and w.customer_id = new.customer_id and w.status <> 'invoiced'
       and i.tax_source = 'customer_exempt';
  end if;
  return null;
end $$;
revoke all on function private.exemption_changed() from public;

create trigger customer_billing_exemption_changed
  after insert or update of tax_exempt on public.customer_billing
  for each row execute function private.exemption_changed();

-- Existing open orders of exempt customers.
update public.work_order_internal i
   set tax_source = 'customer_exempt'
  from public.work_orders w
  join public.customer_billing b on b.customer_id = w.customer_id and b.tax_exempt
 where w.id = i.work_order_id and w.status <> 'invoiced';
