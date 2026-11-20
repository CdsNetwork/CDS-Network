-- Removing a photo or file from a work order (Sarah, CDS, 2026-11-20: shops added the wrong
-- file and could not remove it).
--
-- public.cds_remove_attachment: CDS removes any file on an order (its own, a shop's, or one
-- recorded without a person), at any status. The history line is CDS only. When the file is
-- the only photo of a condemned DPF, DOC or SCR on a completed order, the work order page
-- warns in the confirm text; the database allows it (CDS's call).
--
-- public.shop_remove_attachment: a shop removes a file its own login uploaded while it can
-- still edit the job (private.shop_can_edit: accepted, picked up, in process). Never after
-- completion, never a CDS file (no shop stamp), never a file recorded without a person, never
-- another shop's file (stamped with that shop). shop_complete_work_order checks the photos of
-- condemned parts again, so no extra rule is needed before completion. The history line is
-- visible to the shop, and the order shows "New from shop" for CDS (shop activity 'file').
--
-- Both write "File removed: <file name> (by <name>)" (event_type 'file_removed'): the CDS
-- person's name, or the shop's name. Both delete the row and return its storage path; the
-- app removes the stored object afterwards (a failed removal leaves only an unreachable
-- object). Shops have no storage delete policy, so the shop action removes it with the
-- service role.
--
-- Direct DELETE on public.attachments is revoked from authenticated (shops never had a delete
-- policy; CDS had one through cds_all), so every removal goes through these functions and is
-- in the history. public.cds_delete_work_order (security definer) still removes the files of
-- a deleted order.

create function public.cds_remove_attachment(p_work_order uuid, p_attachment uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  a public.attachments;
  who text;
begin
  perform private.require_cds();
  delete from public.attachments
   where id = p_attachment and work_order_id = p_work_order
  returning * into a;
  if a.id is null then
    raise exception 'File not found' using errcode = 'P0002';
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), 'CDS') into who from public.profiles p where p.id = auth.uid();
  perform private.log_event(a.work_order_id, 'file_removed', null, null,
    left('File removed: ' || a.file_name || ' (by ' || coalesce(who, 'CDS') || ')', 2500), false);
  return a.storage_path;
end $$;

create function public.shop_remove_attachment(p_work_order uuid, p_attachment uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  wo public.work_orders := private.my_work_order(p_work_order);
  a public.attachments;
  shop_name text;
begin
  perform private.shop_can_edit(wo);
  select * into a from public.attachments
   where id = p_attachment and work_order_id = wo.id
   for update;
  -- What the shop cannot see (another shop's file, a CDS-only file) is not found.
  if a.id is null or not a.shop_visible or (a.affiliate_id is not null and a.affiliate_id <> wo.affiliate_id) then
    raise exception 'File not found' using errcode = 'P0002';
  end if;
  if a.affiliate_id is null or not private.is_shop_login(a.uploaded_by) then
    raise exception 'Only files your shop added can be removed' using errcode = 'P0001';
  end if;
  delete from public.attachments where id = a.id;
  select af.display_name into shop_name from public.affiliates af where af.id = wo.affiliate_id;
  perform private.log_event(wo.id, 'file_removed', null, null,
    left('File removed: ' || a.file_name || ' (by ' || coalesce(shop_name, 'Shop') || ')', 2500), true);
  perform private.record_shop_activity(wo.id, 'file');
  return a.storage_path;
end $$;

revoke all on function public.cds_remove_attachment(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cds_remove_attachment(uuid, uuid) to authenticated;
grant execute on function public.cds_remove_attachment(uuid, uuid) to service_role;
revoke all on function public.shop_remove_attachment(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.shop_remove_attachment(uuid, uuid) to authenticated;
grant execute on function public.shop_remove_attachment(uuid, uuid) to service_role;

revoke delete on table public.attachments from authenticated;
