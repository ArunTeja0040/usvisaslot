-- 05-service-state.sql — #90
--
-- Let the operator mark a client Booked or No-longer-needed by hand.
--
-- "Booked" was only ever computed, from slot history and confirmedAt. A client
-- booked outside the bot, or one who no longer wants the service, had no way to
-- leave the Active list — so every "Check all logins" run signed in as them and
-- spent one of their limited daily page-views on an account nobody is working.
--
-- Values: NULL / '' = normal, 'booked', 'not_required'.
--
-- Safe to run more than once. Additive and nullable — an older extension build
-- ignores the column, and a project that has not run this keeps working exactly
-- as before, with the mark held locally on each machine instead of shared.

alter table public.user_profiles
  add column if not exists service_state text;

comment on column public.user_profiles.service_state is
  '#90 Operator-set client state: null/empty = normal, booked = done (manual override on top of the computed booked check), not_required = set aside. Both booked and not_required are skipped by the login sweep.';

-- The dashboard filters by this on every render, always within one operator.
create index if not exists user_profiles_service_state_idx
  on public.user_profiles (operator_id, service_state)
  where service_state is not null;
