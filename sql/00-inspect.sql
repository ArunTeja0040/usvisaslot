-- ============================================================================
-- 00-inspect.sql  —  READ-ONLY. Changes nothing. Safe to run anywhere.
-- Purpose: show how security is currently set up, so the staff rules can be
-- written correctly instead of guessed.
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → paste → Run.
-- Then send me the output of all 5 sections.
-- ============================================================================

-- 1) Is row-level security switched ON for the main tables?
select relname               as table_name,
       relrowsecurity        as rls_enabled,
       relforcerowsecurity   as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('user_profiles','slot_history','event_logs','daily_stats',
                  'devices','operators','request_stats','staff','client_billing')
order by relname;

-- 2) What security rules (policies) already exist?
select tablename, policyname, cmd, permissive, roles,
       qual        as using_condition,
       with_check  as write_condition
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 3) The existing operator-key function (so staff keys can mirror it)
select p.proname as function_name,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_operator_id','get_staff_id');

-- 4) Confirm the columns we plan to touch actually exist as expected
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'user_profiles'
order by ordinal_position;

-- 5) Do the new objects already exist? (should be 0 rows on a fresh project)
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('staff','client_billing');
