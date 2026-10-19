-- Follow-ups to BUG-M2-9 (customer tax exemption):
--
--   1. private.order_customer_changed (after update of customer_id on work_orders): an open
--      order moved to another customer follows that customer's exemption, as
--      private.exemption_changed does when the exemption itself changes. Moved to an exempt
--      customer: no tax. Moved away from one: the state's starting tax for the order's
--      location, as a new order would get. Invoiced orders never change.
--   2. private.tax_locked_when_invoiced (before update on work_order_internal): the tax
--      settings of an invoiced order cannot change, through the API as in the app
--      (updateTax refuses with the same message). Other fields can still be edited.

create function private.order_customer_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id is not distinct from old.customer_id or new.status = 'invoiced' then
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

create trigger work_orders_customer_changed
  after update of customer_id on public.work_orders
  for each row execute function private.order_customer_changed();

create function private.tax_locked_when_invoiced() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.tax_rate, new.tax_parts, new.tax_labor, new.tax_shipping, new.tax_source, new.tax_jurisdiction)
       is distinct from (old.tax_rate, old.tax_parts, old.tax_labor, old.tax_shipping, old.tax_source, old.tax_jurisdiction)
     and exists (select 1 from public.work_orders w where w.id = new.work_order_id and w.status = 'invoiced') then
    raise exception 'Tax cannot change after the order is invoiced.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function private.tax_locked_when_invoiced() from public;

create trigger work_order_internal_tax_locked_when_invoiced
  before update on public.work_order_internal
  for each row execute function private.tax_locked_when_invoiced();
