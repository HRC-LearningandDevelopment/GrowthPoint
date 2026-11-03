-- =====================================================================
-- L&D Learning Portal — update 02: email + password sign-in
-- Admin / L&D create accounts and set passwords (no sign-in codes, no
-- email sending). Run ONCE in SQL Editor → New query → paste → Run.
-- =====================================================================

-- New accounts get a temporary password and must change it on first sign-in
alter table public.profiles
  add column if not exists must_change_password boolean not null default true;

-- The first admin was added before this column existed
update public.profiles set must_change_password = true;

-- Emails and logins are changed only through the account manager
-- (the admin-users function), which keeps the login and the profile in step.
create or replace function public.guard_profile() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.user_id := null;
      new.must_change_password := true;
    else
      if lower(new.email) <> lower(old.email) then
        raise exception 'To change an email address, use "Change email" on the People page.';
      end if;
      new.user_id := old.user_id;
    end if;
  end if;
  return new;
end $$;

-- Called by the portal right after someone sets their own new password
create or replace function public.password_changed() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set must_change_password = false
  where user_id = auth.uid();
end $$;
revoke execute on function public.password_changed() from public, anon;
grant execute on function public.password_changed() to authenticated;

-- Admin account: learning@healthreconconnect.com (replaces the Gmail address)
update public.profiles set email = 'learning@healthreconconnect.com' where email = 'jsan8574@gmail.com';

-- Link the Admin login if it was already created
update public.profiles p set user_id = u.id
from auth.users u
where lower(u.email) = lower(p.email) and p.user_id is null;

select email, role, user_id is not null as has_login from public.profiles;
