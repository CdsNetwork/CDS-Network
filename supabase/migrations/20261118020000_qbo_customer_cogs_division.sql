-- QuickBooks Division on shop bills (CDS, 2026-11-16: "this should carry the division,
-- however it will be Customer name/COGS").
--
-- qbo_customer_cogs_division: the Division of every shop bill for a work order of this
-- customer, for example RYDER COGS (Bill.DepartmentRef), the counterpart of the INCOME
-- division its invoices carry (qbo_customer_division). The portal fills it on the customer's
-- first bill by matching QuickBooks's Departments by name (src/lib/qbo/cogs-division.ts),
-- insert only, so a row CDS added or corrected is kept. Without a row the bill is sent
-- without a Division. CDS only, like the other QuickBooks mappings.

create table public.qbo_customer_cogs_division (
  customer_id uuid primary key references public.customers on delete cascade,
  qbo_department_id text not null check (btrim(qbo_department_id) <> '' and char_length(qbo_department_id) <= 50),
  qbo_department_name text not null check (btrim(qbo_department_name) <> '' and char_length(qbo_department_name) <= 500),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.qbo_customer_cogs_division enable row level security;
create policy cds_all on public.qbo_customer_cogs_division for all to authenticated
  using ((select private.is_cds())) with check ((select private.is_cds()));
create trigger touch before update on public.qbo_customer_cogs_division
  for each row execute function private.touch_updated_at();
create trigger audit after insert or update or delete on public.qbo_customer_cogs_division
  for each row execute function private.audit();

-- Grants (20261020000000_explicit_api_grants.sql), the same as the other QuickBooks mappings.
revoke all on table public.qbo_customer_cogs_division from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.qbo_customer_cogs_division to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.qbo_customer_cogs_division to service_role;
