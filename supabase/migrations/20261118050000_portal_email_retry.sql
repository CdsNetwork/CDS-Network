-- Failed status emails to CDS are retried (review 2026-11-16, M4).
--
-- Each status email is claimed by its first integration_sync row (system 'email', entity
-- 'portal_email', external_id = the change's key; src/lib/portal-email-store.ts). That row won
-- whatever its outcome: an email that failed (Resend down) or was abandoned while sending was
-- never sent, and every later attempt was recorded as "already emailed".
--
-- 1. integration_sync.attempts (how many times the row was claimed, 1 for every existing row)
--    and attempted_at (when the row was last taken over; null until then). Only the portal
--    emails use them.
-- 2. public.portal_email_reclaim(row, max attempts) (service role only): takes over the
--    claim row of an email that ended in error, or is still sending 5 minutes after it was
--    last claimed, if the change is younger than 24 hours (Resend keeps an idempotency key for
--    24 hours, and the retry sends with the same key, so Resend never sends it twice) and,
--    when given, it had fewer than max attempts. Returns the new attempt number, or null when
--    the row cannot be taken over. Skipped (emails turned off) and sent rows are never taken
--    over. Atomic: of two at the same moment, one gets it.
-- tests/rls/grants.snapshot.json lists the new function.

alter table public.integration_sync
  add column attempts integer not null default 1 check (attempts >= 1),
  add column attempted_at timestamptz;

create index integration_sync_portal_email_retry on public.integration_sync (at)
  where system = 'email' and entity = 'portal_email' and status in ('error', 'sending');

create function public.portal_email_reclaim(p_row bigint, p_max_attempts integer default null)
returns integer language sql security definer set search_path = '' as $$
  update public.integration_sync s
     set status = 'sending', attempts = s.attempts + 1, attempted_at = now()
   where s.id = p_row
     and s.system = 'email' and s.entity = 'portal_email'
     and s.at > now() - interval '24 hours'
     and (p_max_attempts is null or s.attempts < p_max_attempts)
     and (s.status = 'error'
          or (s.status = 'sending' and coalesce(s.attempted_at, s.at) < now() - interval '5 minutes'))
  returning s.attempts
$$;

revoke all on function public.portal_email_reclaim(bigint, integer) from public, anon, authenticated, service_role;
grant execute on function public.portal_email_reclaim(bigint, integer) to service_role;
