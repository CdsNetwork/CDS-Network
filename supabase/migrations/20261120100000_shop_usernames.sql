-- Username logins for shops (Ashley, 2026-11-19).
--
-- Some shops have several locations that share one email, and Supabase Auth needs a unique
-- email per login. CDS now gives such a shop location a username (default: the shop's name,
-- e.g. "CDS Allentown") and a recovery email, which several locations may share.
--
-- 1. profiles.username (citext: unique and matched in any case, across all logins, active or
--    not) and profiles.recovery_email. Only shop logins have a username; a username login
--    always has a recovery email. Usernames are 3 to 60 letters, digits, dots, dashes,
--    underscores and single spaces, with no space at either end (so never an "@": the sign in
--    page treats a value with "@" as an email).
-- 2. The auth email of a username login is an internal address under login.invalid
--    (src/lib/shop-login.ts). .invalid is reserved (RFC 2606, RFC 6761): it never resolves, so
--    no mail can ever reach anyone. Only username logins use it. Password links for these
--    logins are mailed by the app to the recovery email (src/lib/shop-login-server.ts).
-- 3. Reading: unchanged policies. A shop reads only its own profile row (shop_read) and
--    cannot update profiles at all; CDS reads and edits every row (cds_all). Changes are in the
--    change log (the audit trigger on profiles).
-- 4. public.auth_rate_limit(key, limit, window seconds, record) (service role only): true
--    when the key has at least `limit` attempts in the last window seconds (counted before
--    this one); records this attempt when p_record. Keys are hashed by the app (never an email,
--    username or IP in clear). Rows older than a day are removed as it goes.
-- 5. app_settings "shop_username_logins" = {"enabled": false}: the feature is off until CDS
--    turns it on (end of this file).
-- tests/rls/grants.snapshot.json lists the new function.

alter table public.profiles
  add column username extensions.citext,
  add column recovery_email extensions.citext,
  add constraint profiles_username_format check (
    username is null
    or (char_length(username::text) between 3 and 60
        and username::text ~ '^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$')
  ),
  add constraint profiles_username_shop_only check (username is null or kind = 'shop'),
  add constraint profiles_username_recovery check ((username is null) = (recovery_email is null)),
  add constraint profiles_recovery_email_format check (
    recovery_email is null
    or (recovery_email::text ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and lower(recovery_email::text) not like '%@login.invalid')
  ),
  add constraint profiles_internal_email_username_only check (
    (username is null) = (lower(email::text) not like '%@login.invalid')
  );

create unique index profiles_username_key on public.profiles (username) where username is not null;

create table private.auth_attempts (
  id bigint generated always as identity primary key,
  key text not null,
  at timestamptz not null default now()
);
create index auth_attempts_key_at on private.auth_attempts (key, at);
create index auth_attempts_at on private.auth_attempts (at);
revoke all on table private.auth_attempts from public, anon, authenticated;

create function public.auth_rate_limit(p_key text, p_limit integer, p_window_seconds integer, p_record boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if p_key is null or p_limit is null or p_window_seconds is null then
    raise exception 'auth_rate_limit needs a key, a limit and a window' using errcode = '22004';
  end if;
  delete from private.auth_attempts a where a.at < now() - interval '1 day';
  select count(*) into n from private.auth_attempts a
   where a.key = p_key and a.at > now() - make_interval(secs => p_window_seconds);
  if coalesce(p_record, false) then
    insert into private.auth_attempts (key) values (p_key);
  end if;
  return n >= p_limit;
end $$;

revoke all on function public.auth_rate_limit(text, integer, integer, boolean) from public, anon, authenticated, service_role;
grant execute on function public.auth_rate_limit(text, integer, integer, boolean) to service_role;

-- 5. Off until CDS turns it on (Ashley, 2026-11-19: CDS first finishes training shops on the
--    current logins). While off, sign in and Forgot password are exactly as before (email only)
--    and Admin > Shops cannot create username logins (src/lib/shop-login.ts). Turn on with
--    value {"enabled": true}. app_settings is CDS only (cds_all), so shops cannot read or change it.
insert into public.app_settings (key, value) values ('shop_username_logins', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;
