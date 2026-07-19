-- ============================================================================
-- 99-undo-staff-schema.sql  —  Full rollback of 01-staff-schema.sql (issue #50)
--
-- Puts the database back exactly as it was before the multi-user groundwork.
-- Safe because 01 was additive: the original pricing columns on user_profiles
-- were never touched, so no client data is lost by removing these objects.
--
-- ⚠️  This DOES delete the staff list and the copied pricing table. Only run it
--     if you want to abandon / restart the multi-user work.
-- ============================================================================

-- Drop the staff security rules first (if the rules script was ever applied)
drop policy if exists user_profiles_staff_select on public.user_profiles;
drop policy if exists user_profiles_staff_update on public.user_profiles;
drop policy if exists client_billing_owner_only  on public.client_billing;
drop policy if exists slot_history_staff_select   on public.slot_history;
drop policy if exists event_logs_staff_select     on public.event_logs;
drop policy if exists daily_stats_staff_select    on public.daily_stats;

-- Remove the assignment link (client data itself is untouched)
alter table public.user_profiles drop column if exists assigned_staff_id;

-- Remove the new tables + function
drop table    if exists public.client_billing;
drop table    if exists public.staff;
drop function if exists public.get_staff_id();

-- Verify everything is gone (expect 0 rows)
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('staff','client_billing');
