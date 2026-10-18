-- Email intake (milestone 2): work request emails to dispatch@cds.direct become draft work
-- orders that CDS reviews.
--
--  * inbound_emails (placeholder since the core schema) now stores the whole email, what
--    was read from it (parsed: fields, per-field source, confidence) and the draft order.
--    CDS-only: the core schema gave it RLS with the CDS policy and no shop or anon access.
--  * The message id stays unique: the same email is never processed twice.
--  * customer_email_domains: which sender domains belong to which customer. CDS-only.
--  * intake_create_draft_work_order: creates the order in Pending Review (never dispatched;
--    CDS dispatches by hand), links it to the email in one transaction, and returns the
--    existing order when the email was already converted. Callable by CDS staff and by the
--    service role (the webhook has no user session).

-- ---------------------------------------------------------------- inbound_emails

alter table public.inbound_emails
  add column from_header text check (char_length(from_header) <= 500),
  add column to_addresses text[] not null default '{}',
  add column body_text text check (char_length(body_text) <= 200000),
  add column body_html text check (char_length(body_html) <= 200000),
  add column attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  add column source text not null default 'webhook' check (source in ('webhook', 'paste')),
  add column confidence numeric(3,2) check (confidence between 0 and 1),
  add column attempts integer not null default 0 check (attempts >= 0),
  add column processed_at timestamptz,
  add column created_by uuid references public.profiles on delete set null,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();

alter table public.inbound_emails alter column mailbox set default 'dispatch@cds.direct';
alter table public.inbound_emails
  add constraint inbound_emails_message_id_length check (char_length(provider_message_id) between 1 and 998),
  add constraint inbound_emails_subject_length check (char_length(subject) <= 1000),
  add constraint inbound_emails_error_length check (char_length(error) <= 2000),
  add constraint inbound_emails_parsed_object check (parsed is null or jsonb_typeof(parsed) = 'object');

-- Statuses: new (stored), parsed (read, waiting for CDS: no customer, or the order could not
-- be made), failed (an error; retry from /cds/intake), ignored (not a work request),
-- converted (draft work order created).
alter table public.inbound_emails drop constraint if exists inbound_emails_status_check;
update public.inbound_emails set status = case status
  when 'needs_review' then 'parsed'
  when 'created_wo' then 'converted'
  when 'error' then 'failed'
  else status end;
alter table public.inbound_emails
  add constraint inbound_emails_status_check check (status in ('new', 'parsed', 'failed', 'ignored', 'converted')),
  add constraint inbound_emails_order_means_converted check (work_order_id is null or status = 'converted');

-- Deleting a work order (or an email) unlinks the other side instead of failing.
alter table public.inbound_emails drop constraint inbound_emails_work_order_id_fkey;
alter table public.inbound_emails
  add constraint inbound_emails_work_order_id_fkey foreign key (work_order_id) references public.work_orders on delete set null;
alter table public.work_order_internal drop constraint work_order_internal_inbound_email_id_fkey;
alter table public.work_order_internal
  add constraint work_order_internal_inbound_email_id_fkey foreign key (inbound_email_id) references public.inbound_emails on delete set null;

-- One email makes at most one order, and one order comes from at most one email.
create unique index inbound_emails_one_per_order on public.inbound_emails (work_order_id) where work_order_id is not null;
create index inbound_emails_received on public.inbound_emails (received_at desc);
create index inbound_emails_status on public.inbound_emails (status, received_at desc);
create unique index work_order_internal_one_per_email on public.work_order_internal (inbound_email_id)
  where inbound_email_id is not null;

create trigger touch before update on public.inbound_emails for each row execute function private.touch_updated_at();

-- An order read from an email is never dispatched automatically.
alter table public.work_order_internal
  add constraint email_orders_not_auto_dispatched check (source <> 'email_import' or not auto_dispatched);

-- ---------------------------------------------------------------- sender domains

create table public.customer_email_domains (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers on delete cascade,
  domain extensions.citext not null unique
    check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and char_length(domain) <= 253),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);
create index on public.customer_email_domains (customer_id);

alter table public.customer_email_domains enable row level security;
revoke all on public.customer_email_domains from anon;
revoke truncate, references, trigger on public.customer_email_domains from authenticated;
create policy cds_all on public.customer_email_domains for all to authenticated
  using ((select private.is_cds())) with check ((select private.is_cds()));
create trigger touch before update on public.customer_email_domains for each row execute function private.touch_updated_at();
create trigger audit after insert or update or delete on public.customer_email_domains
  for each row execute function private.audit();

-- ---------------------------------------------------------------- draft work order

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
  p_lines jsonb  -- [{ "catalog_item_id": uuid, "qty": number }]
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
  if p_location is not null then
    select * into loc from public.customer_locations l where l.id = p_location and l.customer_id = p_customer;
    if not found then
      raise exception 'That location does not belong to this customer' using errcode = 'P0001';
    end if;
  end if;

  insert into public.work_orders
    (customer_id, location_id, location_label, site_address, request_type, fulfillment,
     unit_number, po_number, requested_work, status)
  values
    (p_customer, p_location,
     left(coalesce(nullif(btrim(p_location_label), ''), loc.code || ' ' || loc.name, 'Location not matched'), 200),
     left(coalesce(nullif(btrim(p_site_address), ''), loc.address_raw), 500),
     coalesce(p_request_type, 'service'), coalesce(p_fulfillment, 'unspecified'),
     coalesce(nullif(btrim(p_unit_number), ''), 'Not given'),
     nullif(btrim(p_po_number), ''),
     coalesce(nullif(btrim(p_requested_work), ''), nullif(btrim(em.subject), ''), 'See the email'),
     'pending_review')
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
    (work_order_id, source, inbound_email_id, internal_notes, routing_notes, review_reason, auto_dispatched)
  values
    (wo, 'email_import', em.id, notes, loc.routing_notes,
     coalesce(nullif(btrim(p_review_reason), ''), 'From email: check before dispatch'), false);

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
  uuid, uuid, uuid, text, text, public.request_type, public.fulfillment_method, text, text, text, text, text, jsonb
) from public, anon;
grant execute on function public.intake_create_draft_work_order(
  uuid, uuid, uuid, text, text, public.request_type, public.fulfillment_method, text, text, text, text, text, jsonb
) to authenticated, service_role;
