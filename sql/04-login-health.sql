-- 04-login-health.sql — #85
--
-- Share login-check results across Chrome profiles and machines.
--
-- A check's result was written only to chrome.storage.local, which is private to
-- one Chrome profile on one machine. Whoever actually handles a client could not
-- see whether their login still works unless they happened to be sitting at the
-- machine that ran the check.
--
-- These three columns carry it the same way `status` is already carried, so every
-- dashboard shows the same answer.
--
-- Safe to run more than once. Additive and nullable — nothing existing changes,
-- and an older extension build simply ignores the new columns.

alter table public.user_profiles
  add column if not exists login_health_state  text,
  add column if not exists login_health_detail text,
  add column if not exists login_checked_at    timestamptz;

comment on column public.user_profiles.login_health_state is
  '#85 Result of the last login check: healthy | security_mismatch | password_changed | captcha_fail | blocked | timeout.';
comment on column public.user_profiles.login_health_detail is
  '#85 Human-readable detail for that result, e.g. which security question had no saved answer.';
comment on column public.user_profiles.login_checked_at is
  '#85 When that check finished. Newest wins when two machines check the same client.';

-- Only ever read filtered by operator, and the row is already fetched by
-- username, so no index is warranted for the state itself. This one supports
-- "show me the stalest checks first" without a sequential scan.
create index if not exists user_profiles_login_checked_at_idx
  on public.user_profiles (operator_id, login_checked_at desc nulls first);
