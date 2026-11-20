-- Two requests from Sarah (CDS, 2026-11-20).
--
-- 1. Component manufacturer is a list: CUMMINS, DETROIT, VOLVO, ISUZU, NAVISTAR,
--    INTERNATIONAL or N/A (src/lib/manufacturers.ts holds the same list). shop_save_component
--    (same signature, so its grants stay) refuses any other value, except the value the
--    component already has: a component saved before the list keeps its typed value when the
--    shop saves it again, and can only change to the list. No value is still allowed while
--    the shop fills the card in; shop_complete_work_order still requires one. Rows already
--    saved are not changed, and there is no check constraint: a NOT VALID constraint is still
--    checked on every update of an old row, so saving a result on a component with an older
--    typed manufacturer would fail. The QuickBooks invoice reads the stored value as before.
--
-- 2. The customer's part number on the order: work_orders.customer_part_number (nullable, at
--    most 200 characters: email intake may join several with ", "). Shop-readable like the
--    unit and PO (the shop_read row policy on work_orders, no column grants); only CDS
--    changes it (no shop update policy on work_orders). Not a QuickBooks invoice input, so
--    private.invoice_inputs_locked does not list it. cds_create_work_order and
--    intake_create_draft_work_order take it as a new last parameter with a default, so they
--    are dropped and created again (a new overload would make named calls ambiguous) and
--    granted as before (20261020000000_explicit_api_grants.sql). Their bodies are otherwise
--    the current ones (20261015000000_qa_round1_fixes.sql, 20261027000000_intake_unit_number_optional.sql).

-- ---------------------------------------------------------------- 1. manufacturer list

create or replace function public.shop_save_component(
  p_work_order uuid,
  p_component uuid,
  p_type public.component_type,
  p_manufacturer text,
  p_part_number text,
  p_serial_number text,
  p_dp_before numeric,
  p_dp_after numeric,
  p_weight_before_g numeric,
  p_weight_after_g numeric,
  p_result public.component_result,
  p_result_note text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  saved uuid;
  mfr text := nullif(btrim(p_manufacturer), '');
  saved_mfr text;
begin
  perform private.shop_can_edit(wo);
  -- The list (src/lib/manufacturers.ts). A value typed before the list stays when the
  -- component is saved again; it can only change to the list.
  if mfr is not null and mfr not in ('CUMMINS', 'DETROIT', 'VOLVO', 'ISUZU', 'NAVISTAR', 'INTERNATIONAL', 'N/A') then
    if p_component is not null then
      select c.manufacturer into saved_mfr from public.work_order_components c
       where c.id = p_component and c.work_order_id = wo.id;
    end if;
    if saved_mfr is distinct from mfr then
      raise exception 'Choose the manufacturer from the list' using errcode = 'P0001';
    end if;
  end if;
  perform private.check_length(btrim(p_manufacturer), 100);
  perform private.check_length(btrim(p_part_number), 100);
  perform private.check_length(btrim(p_serial_number), 100);
  perform private.check_length(btrim(p_result_note), 2000);
  if p_component is null then
    insert into public.work_order_components
      (work_order_id, affiliate_id, seq, component_type, manufacturer, part_number, serial_number,
       dp_before, dp_after, weight_before_g, weight_after_g, result, result_note, updated_by)
    values
      (wo.id, wo.affiliate_id,
       coalesce((select max(seq) from public.work_order_components where work_order_id = wo.id), 0) + 1,
       p_type, mfr, nullif(btrim(p_part_number), ''), nullif(btrim(p_serial_number), ''),
       p_dp_before, p_dp_after, p_weight_before_g, p_weight_after_g, p_result, nullif(btrim(p_result_note), ''),
       auth.uid())
    returning id into saved;
  else
    update public.work_order_components
       set component_type = p_type, manufacturer = mfr,
           part_number = nullif(btrim(p_part_number), ''), serial_number = nullif(btrim(p_serial_number), ''),
           dp_before = p_dp_before, dp_after = p_dp_after,
           weight_before_g = p_weight_before_g, weight_after_g = p_weight_after_g,
           result = p_result, result_note = nullif(btrim(p_result_note), ''), updated_by = auth.uid()
     where id = p_component and work_order_id = wo.id
       and (affiliate_id = wo.affiliate_id or affiliate_id is null)
    returning id into saved;
    if saved is null then
      raise exception 'Component not found' using errcode = 'P0002';
    end if;
  end if;
  return saved;
end $$;

-- ---------------------------------------------------------------- 2. customer part number

alter table public.work_orders
  add column customer_part_number text,
  add constraint work_orders_customer_part_number_len check (char_length(customer_part_number) <= 200);

comment on column public.work_orders.customer_part_number is
  'The customer''s part number for the job (for example the Part # on a Ryder request). Shown to the shop with the unit and PO.';

drop function public.cds_create_work_order(uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,jsonb);

create function public.cds_create_work_order(
  p_customer uuid,
  p_location uuid,
  p_location_label text,
  p_site_address text,
  p_request_type public.request_type,
  p_fulfillment public.fulfillment_method,
  p_unit_number text,
  p_po_number text,
  p_requested_work text,
  p_internal_notes text,
  p_lines jsonb,  -- [{ "catalog_item_id": uuid, "qty": number }]
  p_customer_part_number text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  wo uuid;
  line jsonb;
  loc_code text;
  loc_name text;
  loc_address text;
  loc_notes text;
begin
  perform private.require_cds();
  if coalesce(btrim(p_unit_number), '') = '' or coalesce(btrim(p_requested_work), '') = '' then
    raise exception 'Unit number and requested work are required' using errcode = 'P0001';
  end if;
  perform private.check_length(btrim(p_unit_number), 100);
  perform private.check_length(btrim(p_po_number), 100);
  perform private.check_length(btrim(p_customer_part_number), 200);
  perform private.check_length(btrim(p_location_label), 200);
  perform private.check_length(btrim(p_site_address), 500);
  perform private.check_length(btrim(p_requested_work), 2000);
  perform private.check_length(btrim(p_internal_notes), 2000);
  if p_location is not null then
    select l.code, l.name, l.address_raw, l.routing_notes into loc_code, loc_name, loc_address, loc_notes
    from public.customer_locations l where l.id = p_location and l.customer_id = p_customer;
    if not found then
      raise exception 'That location does not belong to this customer' using errcode = 'P0001';
    end if;
  end if;

  insert into public.work_orders
    (customer_id, location_id, location_label, site_address, request_type, fulfillment,
     unit_number, po_number, requested_work, customer_part_number)
  values
    (p_customer, p_location,
     left(coalesce(nullif(btrim(p_location_label), ''), loc_code || ' ' || loc_name, 'Unknown location'), 200),
     left(coalesce(nullif(btrim(p_site_address), ''), loc_address), 500), p_request_type, p_fulfillment,
     btrim(p_unit_number), nullif(btrim(p_po_number), ''), btrim(p_requested_work),
     nullif(btrim(p_customer_part_number), ''))
  returning id into wo;

  insert into public.work_order_internal (work_order_id, source, internal_notes, routing_notes, review_reason)
  values (wo, 'manual', nullif(btrim(p_internal_notes), ''), loc_notes,
          case when p_location is null then 'Location not matched'
               when coalesce(btrim(p_po_number), '') = '' then 'PO number missing' end);

  for line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.work_order_lines (work_order_id, catalog_item_id, qty, origin)
    values (wo, (line ->> 'catalog_item_id')::uuid, (line ->> 'qty')::numeric, 'cds_order');
  end loop;

  perform private.log_event(wo, 'create', null, 'pending_review', 'Work order created', false);
  return wo;
end $$;

revoke all on function public.cds_create_work_order(uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.cds_create_work_order(uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,jsonb,text) to authenticated;
grant execute on function public.cds_create_work_order(uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,jsonb,text) to service_role;

drop function public.intake_create_draft_work_order(uuid,uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,text,jsonb,text,integer,date,boolean,text,text,text,text,text);

create function public.intake_create_draft_work_order(
  p_email uuid,
  p_customer uuid,
  p_location uuid,
  p_location_label text,
  p_site_address text,
  p_request_type public.request_type,
  p_fulfillment public.fulfillment_method,
  p_unit_number text,
  p_po_number text,
  p_requested_work text,
  p_internal_notes text,
  p_review_reason text,
  p_lines jsonb,  -- [{ "catalog_item_id": uuid, "qty": number }]
  p_vin text default null,
  p_mileage integer default null,
  p_requested_date date default null,
  p_return_to_location boolean default false,
  p_order_type text default null,
  p_customer_region text default null,
  p_contact_name text default null,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_customer_part_number text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  em public.inbound_emails;
  wo uuid;
  line jsonb;
  item_label text;
  skipped text[] := '{}';
  loc public.customer_locations;
  rate public.tax_rates;
  notes text;
begin
  if not private.is_cds() and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only CDS staff can do this' using errcode = '42501';
  end if;

  select * into em from public.inbound_emails where id = p_email for update;
  if not found then
    raise exception 'Email not found' using errcode = 'P0002';
  end if;
  if em.work_order_id is not null then
    return em.work_order_id;  -- already converted: never a second order
  end if;
  if em.status = 'ignored' then
    raise exception 'This email was marked as not a work request' using errcode = 'P0001';
  end if;

  perform private.check_length(btrim(p_unit_number), 100);
  perform private.check_length(btrim(p_po_number), 100);
  perform private.check_length(btrim(p_customer_part_number), 200);
  perform private.check_length(btrim(p_location_label), 200);
  perform private.check_length(btrim(p_site_address), 500);
  perform private.check_length(btrim(p_requested_work), 2000);
  perform private.check_length(btrim(p_internal_notes), 2000);
  perform private.check_length(btrim(p_review_reason), 500);
  perform private.check_length(btrim(p_vin), 30);
  perform private.check_length(btrim(p_order_type), 100);
  perform private.check_length(btrim(p_customer_region), 100);
  perform private.check_length(btrim(p_contact_name), 200);
  perform private.check_length(btrim(p_contact_email), 320);
  perform private.check_length(btrim(p_contact_phone), 50);
  if p_mileage is not null and (p_mileage < 0 or p_mileage >= 10000000) then
    raise exception 'Mileage must be between 0 and 9,999,999' using errcode = 'P0001';
  end if;
  if p_location is not null then
    select * into loc from public.customer_locations l where l.id = p_location and l.customer_id = p_customer;
    if not found then
      raise exception 'That location does not belong to this customer' using errcode = 'P0001';
    end if;
  end if;

  insert into public.work_orders
    (customer_id, location_id, location_label, site_address, request_type, fulfillment,
     unit_number, po_number, requested_work, status, vin, mileage, requested_date, return_to_location,
     customer_part_number)
  values
    (p_customer, p_location,
     left(coalesce(nullif(btrim(p_location_label), ''), loc.code || ' ' || loc.name, 'Location not matched'), 200),
     left(coalesce(nullif(btrim(p_site_address), ''), loc.address_raw), 500),
     coalesce(p_request_type, 'service'), coalesce(p_fulfillment, 'unspecified'),
     nullif(btrim(p_unit_number), ''),
     nullif(btrim(p_po_number), ''),
     coalesce(nullif(btrim(p_requested_work), ''), nullif(btrim(em.subject), ''), 'See the email'),
     'pending_review', nullif(upper(btrim(p_vin)), ''), p_mileage, p_requested_date, coalesce(p_return_to_location, false),
     nullif(btrim(p_customer_part_number), ''))
  returning id into wo;

  -- Lines without a customer price (or an unknown item) are left off and named in the notes.
  for line in select * from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) loop
    begin
      insert into public.work_order_lines (work_order_id, catalog_item_id, qty, origin)
      values (wo, (line ->> 'catalog_item_id')::uuid, greatest(coalesce((line ->> 'qty')::numeric, 1), 1), 'cds_order');
    exception when sqlstate 'P0001' or foreign_key_violation or invalid_text_representation
                   or check_violation or not_null_violation or numeric_value_out_of_range then
      select c.sku into item_label from public.catalog_items c
       where c.id = case when (line ->> 'catalog_item_id') ~* '^[0-9a-f-]{36}$' then (line ->> 'catalog_item_id')::uuid end;
      skipped := skipped || coalesce(item_label, coalesce(line ->> 'catalog_item_id', '?'));
    end;
  end loop;

  notes := nullif(btrim(p_internal_notes), '');
  if array_length(skipped, 1) > 0 then
    notes := left(coalesce(notes || E'\n', '') || 'Not added (no customer price): ' || array_to_string(skipped, ', ') || '.', 2000);
  end if;

  insert into public.work_order_internal
    (work_order_id, source, inbound_email_id, internal_notes, routing_notes, review_reason, auto_dispatched,
     order_type, customer_region, customer_contact_name, customer_contact_email, customer_contact_phone)
  values
    (wo, 'email_import', em.id, notes, loc.routing_notes,
     coalesce(nullif(btrim(p_review_reason), ''), 'From email: check before dispatch'), false,
     nullif(btrim(p_order_type), ''), nullif(btrim(p_customer_region), ''), nullif(btrim(p_contact_name), ''),
     nullif(lower(btrim(p_contact_email)), ''), nullif(btrim(p_contact_phone), ''));

  -- Starting tax rate from the location's state, as the Create Work Order form does.
  if loc.region is not null then
    select * into rate from public.tax_rates t
     where t.market = loc.market and t.region = loc.region and t.postal_code is null;
    if found then
      update public.work_order_internal
         set tax_rate = rate.rate, tax_parts = rate.taxes_parts, tax_labor = rate.taxes_labor,
             tax_shipping = rate.taxes_shipping, tax_jurisdiction = loc.region, tax_source = 'state_fallback'
       where work_order_id = wo;
    end if;
  end if;

  update public.inbound_emails
     set status = 'converted', work_order_id = wo, error = null, processed_at = now()
   where id = em.id;

  insert into public.integration_sync (system, entity, entity_id, external_id, direction, status)
  values ('email', 'work_order', wo, left(em.provider_message_id, 500), 'pull', 'draft_created');

  perform private.log_event(wo, 'create', null, 'pending_review', 'Draft work order created from an email', false);
  return wo;
end $$;

revoke all on function public.intake_create_draft_work_order(uuid,uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,text,jsonb,text,integer,date,boolean,text,text,text,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.intake_create_draft_work_order(uuid,uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,text,jsonb,text,integer,date,boolean,text,text,text,text,text,text) to authenticated;
grant execute on function public.intake_create_draft_work_order(uuid,uuid,uuid,text,text,public.request_type,public.fulfillment_method,text,text,text,text,text,jsonb,text,integer,date,boolean,text,text,text,text,text,text) to service_role;
