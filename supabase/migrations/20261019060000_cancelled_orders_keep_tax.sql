-- BUG-M2-13: cancelled orders keep the tax stored on them, like invoiced orders. The page
-- (TAX_FROZEN_STATUSES in src/lib/tax.ts) shows what is stored for both, so the triggers
-- that make an order's tax follow the customer's exemption skip both statuses:
--   * private.tax_follows_exemption (before insert or update on work_order_internal)
--   * private.exemption_changed (after insert or update of tax_exempt on customer_billing)
--   * private.order_customer_changed (after update of customer_id on work_orders)

create or replace function private.tax_follows_exemption() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders;
begin
  select * into wo from public.work_orders where id = new.work_order_id;
  if wo.status in ('invoiced', 'cancelled') then
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
     where w.id = i.work_order_id and w.customer_id = new.customer_id and w.status not in ('invoiced', 'cancelled');
  elsif tg_op = 'UPDATE' then
    update public.work_order_internal i
       set tax_rate = s.rate, tax_parts = s.taxes_parts, tax_labor = s.taxes_labor,
           tax_shipping = s.taxes_shipping, tax_jurisdiction = coalesce(s.jurisdiction, i.tax_jurisdiction),
           tax_source = s.source
      from public.work_orders w
      cross join lateral private.starting_tax(w.location_id) s
     where w.id = i.work_order_id and w.customer_id = new.customer_id and w.status not in ('invoiced', 'cancelled')
       and i.tax_source = 'customer_exempt';
  end if;
  return null;
end $$;
revoke all on function private.exemption_changed() from public;

create or replace function private.order_customer_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id is not distinct from old.customer_id or new.status in ('invoiced', 'cancelled') then
    return null;
  end if;
  if coalesce((select b.tax_exempt from public.customer_billing b where b.customer_id = new.customer_id), false) then
    -- private.tax_follows_exemption sets the no tax settings.
    update public.work_order_internal set tax_source = 'customer_exempt' where work_order_id = new.id;
  else
    update public.work_order_internal i
       set tax_rate = s.rate, tax_parts = s.taxes_parts, tax_labor = s.taxes_labor,
           tax_shipping = s.taxes_shipping, tax_jurisdiction = coalesce(s.jurisdiction, i.tax_jurisdiction),
           tax_source = s.source
      from private.starting_tax(new.location_id) s
     where i.work_order_id = new.id and i.tax_source = 'customer_exempt';
  end if;
  return null;
end $$;
revoke all on function private.order_customer_changed() from public;
