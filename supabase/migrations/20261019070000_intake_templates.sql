-- Email intake reads the request templates CDS receives (Ryder pick up request, First
-- Student iProcure PO, website fleet form) and XPO's free text. What they carry is stored:
--
--  * work_orders (shop-facing, the shop needs them for the job): vin, mileage,
--    requested_date (the date the customer asked for), return_to_location (an EGR cooler
--    that goes back to the customer's location).
--  * work_order_internal (CDS-only): order_type and customer_region (the customer's own
--    order classification and region), customer_contact_name / _email / _phone (the person
--    who placed the request).
--  * inbound_emails.in_reply_to: the In-Reply-To header, so a reprocessed reply is still
--    recognised as a reply. inbound_emails.mailbox (already there) now records the inbox the
--    email arrived at (dispatch@, xpo@, the ryder@ group) instead of always dispatch@.
--  * intake_create_draft_work_order takes the new values (optional, so existing callers work).
--  * intake_note_po_reference: a "Ryder Purchase Order: PO # ... Issued for" email is noted
--    on the one open order with that PO number (an event, CDS-only), never a new order.

alter table public.work_orders
  add column vin text check (char_length(vin) <= 30),
  add column mileage integer check (mileage between 0 and 9999999),
  add column requested_date date,
  add column return_to_location boolean not null default false;

alter table public.work_order_internal
  add column order_type text check (char_length(order_type) <= 100),
  add column customer_region text check (char_length(customer_region) <= 100),
  add column customer_contact_name text check (char_length(customer_contact_name) <= 200),
  add column customer_contact_email text check (char_length(customer_contact_email) <= 320),
  add column customer_contact_phone text check (char_length(customer_contact_phone) <= 50);

alter table public.inbound_emails
  add column in_reply_to text check (char_length(in_reply_to) <= 998);

-- ---------------------------------------------------------------- draft work order

drop function public.intake_create_draft_work_order(
  uuid, uuid, uuid, text, text, public.request_type, public.fulfillment_method, text, text, text, text, text, jsonb
);

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
  p_contact_phone text default null
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
     unit_number, po_number, requested_work, status, vin, mileage, requested_date, return_to_location)
  values
    (p_customer, p_location,
     left(coalesce(nullif(btrim(p_location_label), ''), loc.code || ' ' || loc.name, 'Location not matched'), 200),
     left(coalesce(nullif(btrim(p_site_address), ''), loc.address_raw), 500),
     coalesce(p_request_type, 'service'), coalesce(p_fulfillment, 'unspecified'),
     coalesce(nullif(btrim(p_unit_number), ''), 'Not given'),
     nullif(btrim(p_po_number), ''),
     coalesce(nullif(btrim(p_requested_work), ''), nullif(btrim(em.subject), ''), 'See the email'),
     'pending_review', nullif(upper(btrim(p_vin)), ''), p_mileage, p_requested_date, coalesce(p_return_to_location, false))
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


revoke all on function public.intake_create_draft_work_order(
  uuid, uuid, uuid, text, text, public.request_type, public.fulfillment_method, text, text, text, text, text, jsonb, text, integer, date, boolean, text, text, text, text, text
) from public, anon;
grant execute on function public.intake_create_draft_work_order(
  uuid, uuid, uuid, text, text, public.request_type, public.fulfillment_method, text, text, text, text, text, jsonb, text, integer, date, boolean, text, text, text, text, text
) to authenticated, service_role;

-- ---------------------------------------------------------------- Ryder PO paperwork

create function public.intake_note_po_reference(p_email uuid, p_po text)
returns table (work_order_id uuid, wo_number bigint)
language plpgsql security definer set search_path = '' as $$
declare
  em public.inbound_emails;
  hits uuid[];
  wo public.work_orders;
  msg text;
begin
  if not private.is_cds() and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only CDS staff can do this' using errcode = '42501';
  end if;
  select * into em from public.inbound_emails e where e.id = p_email;
  if not found then
    raise exception 'Email not found' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_po), '') = '' then
    return;
  end if;

  select array_agg(w.id) into hits from public.work_orders w
   where w.po_number = btrim(p_po) and w.status not in ('cancelled', 'invoiced');
  if coalesce(array_length(hits, 1), 0) <> 1 then
    return;  -- no open order with that PO, or more than one: nothing is guessed
  end if;
  select * into wo from public.work_orders w where w.id = hits[1];

  msg := left('PO ' || btrim(p_po) || ' paperwork received by email: ' || coalesce(nullif(btrim(em.subject), ''), '(no subject)')
              || ' [' || em.provider_message_id || ']', 1000);
  -- The same email noted once, however often it is processed.
  if not exists (select 1 from public.work_order_events ev
                  where ev.work_order_id = wo.id and ev.event_type = 'po_reference' and ev.message = msg) then
    perform private.log_event(wo.id, 'po_reference', null, null, msg, false);
  end if;
  return query select wo.id, wo.wo_number;
end $$;

revoke all on function public.intake_note_po_reference(uuid, text) from public, anon;
grant execute on function public.intake_note_po_reference(uuid, text) to authenticated, service_role;
