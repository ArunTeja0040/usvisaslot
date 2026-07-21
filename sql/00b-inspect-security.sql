-- ============================================================================
-- 00b-inspect-security.sql — READ-ONLY. Changes nothing.
-- Returns RLS state + existing policies + the operator-key function in ONE
-- result set (Supabase's SQL Editor only shows the last statement's output,
-- which is why the multi-query version got swallowed).
-- ============================================================================

select 'RLS' as section,
       relname as name,
       relrowsecurity::text as detail1,
       '' as detail2
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('user_profiles','slot_history','event_logs','daily_stats',
                  'devices','operators','request_stats')

union all
select 'POLICY',
       tablename || ' :: ' || policyname,
       cmd,
       'USING: ' || coalesce(qual, '(none)') ||
       '  |  WITH CHECK: ' || coalesce(with_check, '(none)')
from pg_policies
where schemaname = 'public'

union all
select 'FUNCTION',
       p.proname,
       '',
       pg_get_functiondef(p.oid)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_operator_id', 'get_staff_id')

order by 1, 2;
