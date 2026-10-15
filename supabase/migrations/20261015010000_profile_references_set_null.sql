-- Deleting a login must not fail because of its history. Every column that points at the
-- person who did something keeps the record and loses the reference when that person's
-- login is deleted. (Staff and shops are normally deactivated, not deleted.)
do $$
declare
  fk record;
begin
  for fk in
    select con.conname, rel.relname as table_name, att.attname as column_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and con.confrelid = 'public.profiles'::regclass
      and nsp.nspname = 'public'
      and array_length(con.conkey, 1) = 1
  loop
    execute format('alter table public.%I drop constraint %I', fk.table_name, fk.conname);
    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references public.profiles (id) on delete set null',
      fk.table_name, fk.conname, fk.column_name);
  end loop;
end $$;
