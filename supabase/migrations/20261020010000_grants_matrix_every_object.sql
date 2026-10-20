-- api_grants_matrix returns at least one row per object (BUG-M2-16).
--
-- It only returned rows for PUBLIC, anon, authenticated and service_role, so an object none
-- of them could use produced no rows at all. From 2026-10-30 a new table or sequence created
-- without explicit grants has exactly that ACL, would be missing from the matrix, and the
-- snapshot test (tests/rls/grants.test.ts) would pass although the app gets 42501 on it.
-- Now such an object gives one row with grantee '(none)' and empty privileges, so every
-- public table, view, sequence and function shows up and a new one always fails the test.
--
-- public.api_grants_probe_no_grants() is a canary with no grants for any API role; the test
-- checks that it appears as '(none)'. It does nothing and nobody but its owner can call it.

create or replace function public.api_grants_matrix()
returns table (kind text, object text, grantee text, privileges text)
language sql stable security definer set search_path = '' as $$
  with objs as (
    select case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'view'
             else 'table' end as kind,
           format('%I.%I', n.nspname, c.relname) as object,
           coalesce(c.relacl, pg_catalog.acldefault(
             case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner)) as acl
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid
                        and d.deptype = 'e')
    union all
    select 'function', p.oid::regprocedure::text,
           coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid
                        and d.deptype = 'e')
  ),
  grants as (
    select o.kind, o.object,
           case when a.grantee = 0 then 'PUBLIC' else r.rolname::text end as grantee,
           string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
    from objs o
    cross join lateral pg_catalog.aclexplode(o.acl) a
    left join pg_catalog.pg_roles r on r.oid = a.grantee
    where a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role')
    group by o.kind, o.object, 3
  )
  select g.kind, g.object, g.grantee, g.privileges from grants g
  union all
  select o.kind, o.object, '(none)', '' from objs o
  where not exists (select 1 from grants g where g.kind = o.kind and g.object = o.object)
  order by 1, 2, 3
$$;

revoke all on function public.api_grants_matrix() from public, anon, authenticated, service_role;
grant execute on function public.api_grants_matrix() to service_role;

create or replace function public.api_grants_probe_no_grants()
returns void
language sql immutable set search_path = '' as $$ select $$;

comment on function public.api_grants_probe_no_grants() is
  'Canary for tests/rls/grants.test.ts: has no grants for any API role on purpose.';

revoke all on function public.api_grants_probe_no_grants() from public, anon, authenticated, service_role;
