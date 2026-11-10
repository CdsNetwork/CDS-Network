-- CDS staff add photos and files to a work order themselves.
--
-- Files CDS uploads belong to the order, not to the shop that has it at that moment: they
-- keep no shop stamp (affiliate_id stays null), so the shop the order is dispatched to
-- later, or reassigned to, sees them too (when shop_visible). The shop read policy and the
-- storage read policy already treat a null stamp as "visible to the order's shop".
--
-- Everything else keeps the rule from 20261015000000_qa_round1_fixes.sql: a new row
-- belongs to the shop that has the work order when it is written. That includes files a
-- shop uploads and files written without a person (uploaded_by null).

create or replace function private.stamp_affiliate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.affiliate_id is null then
    -- Nested: NEW has no uploaded_by field on the other tables this trigger stamps.
    if tg_table_name = 'attachments' then
      if exists (select 1 from public.profiles p where p.id = new.uploaded_by and p.kind = 'cds') then
        return new;
      end if;
    end if;
    select w.affiliate_id into new.affiliate_id from public.work_orders w where w.id = new.work_order_id;
  end if;
  return new;
end $$;
revoke all on function private.stamp_affiliate() from public;
