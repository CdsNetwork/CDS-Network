-- QuickBooks Division and Class on invoices (CDS billing, 2026-11-12).
--
-- CDS's QuickBooks company tracks Departments (called "Division") and Classes on the
-- invoice header (ClassTrackingPerTxn on, ClassTrackingPerTxnLine off).
-- 1. qbo_customer_division: the Division of every invoice for a customer, for example
--    RYDER INCOME for every Ryder invoice (Invoice.DepartmentRef).
-- 2. qbo_affiliate_class: the Class of every invoice for an order the shop handled, for
--    example CDS Houston (Invoice.ClassRef). The in-house shop is an ordinary row.
-- Both are data CDS maintains; without a row the invoice is sent without that ref, as
-- before. The QuickBooks name is kept next to the id for whoever reads the table. CDS only.

create table public.qbo_customer_division (
  customer_id uuid primary key references public.customers on delete cascade,
  qbo_department_id text not null check (btrim(qbo_department_id) <> '' and char_length(qbo_department_id) <= 50),
  qbo_department_name text not null check (btrim(qbo_department_name) <> '' and char_length(qbo_department_name) <= 500),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);

create table public.qbo_affiliate_class (
  affiliate_id uuid primary key references public.affiliates on delete cascade,
  qbo_class_id text not null check (btrim(qbo_class_id) <> '' and char_length(qbo_class_id) <= 50),
  qbo_class_name text not null check (btrim(qbo_class_name) <> '' and char_length(qbo_class_name) <= 500),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['qbo_customer_division', 'qbo_affiliate_class'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy cds_all on public.%I for all to authenticated using ((select private.is_cds())) with check ((select private.is_cds()))', t);
    execute format('create trigger touch before update on public.%I for each row execute function private.touch_updated_at()', t);
    execute format(
      'create trigger audit after insert or update or delete on public.%I for each row execute function private.audit()', t);
    -- Grants (20261020000000_explicit_api_grants.sql), the same as the other QuickBooks mappings.
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant delete, insert, maintain, select, update on table public.%I to authenticated', t);
    execute format(
      'grant delete, insert, maintain, references, select, trigger, truncate, update on table public.%I to service_role', t);
  end loop;
end $$;
