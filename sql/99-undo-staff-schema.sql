-- ============================================================================
-- 99-undo-staff-schema.sql — Full rollback of 01 + 02 (issue #50)
--
-- Puts the database back exactly as it was before the multi-user work.
-- Every EXISTING operator policy is left untouched — this only removes the
-- staff objects that 01/02 added, so owner access is unaffected throughout.
--
-- Safe to run more than once. No client data is lost (the original pricing
-- columns on user_profiles were never removed by 01/02).
-- ============================================================================

-- 1) Staff policies (from 02) -------------------------------------------------
drop policy if exists user_profiles_staff_read     on public.user_profiles;
drop policy if exists user_profiles_staff_update   on public.user_profiles;

drop policy if exists devices_staff_read           on public.devices;
drop policy if exists devices_staff_insert         on public.devices;
drop policy if exists devices_staff_update         on public.devices;

drop policy if exists slot_history_staff_read      on public.slot_history;
drop policy if exists slot_history_staff_insert    on public.slot_history;

drop policy if exists event_logs_staff_read        on public.event_logs;
drop policy if exists event_logs_staff_insert      on public.event_logs;

drop policy if exists daily_stats_staff_read       on public.daily_stats;
drop policy if exists daily_stats_staff_insert     on public.daily_stats;
drop policy if exists daily_stats_staff_update     on public.daily_stats;

-- 2) Column-limit trigger (from 02) -------------------------------------------
drop trigger  if exists trg_staff_update_limits on public.user_profiles;
drop function if exists public.enforce_staff_update_limits();

-- 3) Owner-only policies on the new tables (from 01) --------------------------
drop policy if exists staff_owner_all          on public.staff;
drop policy if exists client_billing_owner_all on public.client_billing;

-- 4) Assignment link (client data itself untouched) ---------------------------
alter table public.user_profiles drop column if exists assigned_staff_id;

-- 5) New tables + helper functions --------------------------------------------
drop table    if exists public.client_billing;
drop table    if exists public.staff;
drop function if exists public.staff_usernames();
drop function if exists public.staff_operator_id();
drop function if exists public.get_staff_id();

-- 6) Verify (expect: no rows, and no staff policies listed) -------------------
select table_name
from information_schema.tables
where table_schema = 'public' and table_name in ('staff','client_billing');

select tablename, policyname
from pg_policies
where schemaname = 'public' and policyname like '%staff%';
