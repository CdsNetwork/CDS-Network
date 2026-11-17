-- Linked work orders, light version (Sarah, CDS, 2026-11-17).
--
-- Why: one customer order sometimes needs two shops (for example a DPF to one shop and an
-- EGR cooler to another). CDS creates the second work order the normal way and links the two,
-- so each work order page says "Linked to WO ####". Each work order keeps its own customer
-- invoice; nothing about invoicing changes.
--
-- public.work_order_links: at most one row per work order, pointing to the other work order.
-- The link is set on one side; the app shows it on both (an order linked to this one is found
-- by linked_work_order_id). An order cannot be linked to itself. Deleting either order removes
-- the link.
--
-- CDS only, in its own table:
--   * not on work_orders, because shops read their own work_orders rows (policy shop_read): a
--     column there would be readable by the shop, and the other order may be another shop's;
--   * not on work_order_internal either: a second foreign key from work_order_internal to
--     work_orders would make every existing work_orders <-> work_order_internal embed in the
--     app ambiguous for PostgREST.
-- This table has only the cds_all policy, so a shop login can neither read nor change a link.
-- The app logs each link and unlink as a CDS-only event on both work orders.
-- Grants (20261020000000_explicit_api_grants.sql): like the other CDS-only tables CDS edits
-- directly; tests/rls/grants.snapshot.json lists the table.

create table public.work_order_links (
  work_order_id uuid primary key references public.work_orders on delete cascade,
  linked_work_order_id uuid not null references public.work_orders on delete cascade,
  created_at timestamptz not null default now(),
  constraint work_order_links_not_self check (linked_work_order_id <> work_order_id)
);
create index work_order_links_linked on public.work_order_links (linked_work_order_id);

comment on table public.work_order_links is
  'CDS only: a work order linked to another work order of the same customer order (for example the part sent to a second shop). Shown on both work order pages. Never changes invoicing.';

alter table public.work_order_links enable row level security;
create policy cds_all on public.work_order_links for all to authenticated
  using ((select private.is_cds())) with check ((select private.is_cds()));

revoke all on table public.work_order_links from public, anon, authenticated, service_role;
grant delete, insert, maintain, select, update on table public.work_order_links to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.work_order_links to service_role;
