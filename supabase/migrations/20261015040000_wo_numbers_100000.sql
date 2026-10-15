-- Work order numbers start at 100000 so they can never be mistaken for QuickBooks invoice
-- numbers (about 31,700 to 37,600 in 2026 and rising).
do $$
declare
  w record;
  n bigint := 100000;
begin
  for w in select id from public.work_orders where wo_number < 100000 order by wo_number loop
    update public.work_orders set wo_number = n where id = w.id;
    n := n + 1;
  end loop;
  perform setval('public.wo_number_seq', greatest(n, (select coalesce(max(wo_number), 99999) + 1 from public.work_orders)), false);
end $$;
