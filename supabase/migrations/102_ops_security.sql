-- ============================================================================
-- 102_ops_security.sql — Ops Platform Phase 1: who can see what (issue #79)
--
-- ⚠️  RUN ON THE **TEST** SUPABASE PROJECT FIRST. Run 101 before this.
--
-- Three kinds of caller:
--   • Bots (extension)   — anon key + x-operator-key header. Founder-level, as today.
--   • Founder (web)      — Supabase Auth login, staff.role = 'owner', two-step (aal2).
--   • Staff (web)        — Supabase Auth login, staff.role = 'staff', two-step (aal2).
--
-- SAFETY: existing operator policies are left untouched. Postgres combines
-- permissive policies with OR, so nothing here can reduce what the bots or the
-- current dashboard can do. Staff never see money, passwords or the audit log.
-- No DELETE rule exists on any new table: "delete" means archived_at.
-- Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Helpers (SECURITY DEFINER: they read staff without tripping its RLS)
-- ---------------------------------------------------------------------------

-- The signed-in web user's staff row id. NULL unless the login is linked to an
-- active staff row AND finished the two-step sign-in.
create or replace function public.auth_staff_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select s.id
  from public.staff s
  where s.auth_user_id = auth.uid()
    and s.active
    and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  limit 1;
$$;

-- Founder = the operator key (bots, current dashboard) or a web login with role 'owner'.
create or replace function public.is_founder()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.get_operator_id() is not null
      or exists (select 1 from public.staff s
                 where s.id = public.auth_staff_id() and s.role = 'owner');
$$;

-- Founder signed in on the web (not a bot). Needed where a human must act,
-- e.g. viewing a password.
create or replace function public.is_web_founder()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.staff s
                 where s.id = public.auth_staff_id() and s.role = 'owner');
$$;

-- The operator the caller works for: operator key first, else the web login's.
create or replace function public.app_operator_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select coalesce(public.get_operator_id(),
                  (select s.operator_id from public.staff s where s.id = public.auth_staff_id()));
$$;

-- ---------------------------------------------------------------------------
-- 2) Existing tables — add web-founder access (bots keep their key policies)
-- ---------------------------------------------------------------------------
drop policy if exists ops_founder_read   on public.user_profiles;
drop policy if exists ops_founder_insert on public.user_profiles;
drop policy if exists ops_founder_update on public.user_profiles;
create policy ops_founder_read   on public.user_profiles for select
  using (operator_id = public.app_operator_id() and public.is_founder());
create policy ops_founder_insert on public.user_profiles for insert
  with check (operator_id = public.app_operator_id() and public.is_founder());
create policy ops_founder_update on public.user_profiles for update
  using (operator_id = public.app_operator_id() and public.is_founder())
  with check (operator_id = public.app_operator_id() and public.is_founder());

drop policy if exists ops_founder_all on public.client_billing;
create policy ops_founder_all on public.client_billing for all
  using (operator_id = public.app_operator_id() and public.is_founder())
  with check (operator_id = public.app_operator_id() and public.is_founder());

drop policy if exists ops_founder_read   on public.staff;
drop policy if exists ops_founder_insert on public.staff;
drop policy if exists ops_founder_update on public.staff;
create policy ops_founder_read   on public.staff for select
  using (operator_id = public.app_operator_id() and public.is_founder());
create policy ops_founder_insert on public.staff for insert
  with check (operator_id = public.app_operator_id() and public.is_founder());
create policy ops_founder_update on public.staff for update
  using (operator_id = public.app_operator_id() and public.is_founder())
  with check (operator_id = public.app_operator_id() and public.is_founder());

drop policy if exists ops_team_read on public.devices;
create policy ops_team_read on public.devices for select
  using (operator_id = public.app_operator_id());
drop policy if exists ops_founder_update on public.devices;
create policy ops_founder_update on public.devices for update
  using (operator_id = public.app_operator_id() and public.is_founder());

drop policy if exists ops_team_read on public.slot_history;
create policy ops_team_read on public.slot_history for select
  using (operator_id = public.app_operator_id());
drop policy if exists ops_team_read on public.event_logs;
create policy ops_team_read on public.event_logs for select
  using (operator_id = public.app_operator_id());
drop policy if exists ops_founder_read on public.daily_stats;
create policy ops_founder_read on public.daily_stats for select
  using (operator_id = public.app_operator_id() and public.is_founder());

-- ---------------------------------------------------------------------------
-- 3) Staff see clients through this view only: no prices, no locked secrets.
--    The view runs as its owner, so it filters to the caller's operator itself.
-- ---------------------------------------------------------------------------
create or replace view public.client_cards
with (security_barrier = true) as
select p.id, p.operator_id, p.username, p.visa_type, p.start_date, p.end_date,
       p.locations, p.applicant_count,
       p.security_q1, p.security_q2, p.security_q3,
       p.sec_q1_seen, p.sec_q2_seen, p.sec_q3_seen,
       p.status, p.is_active, p.rate_limited_at, p.stage, p.payment_status,
       p.phone_e164, p.whatsapp_name, p.travel_note, p.assigned_staff_id,
       p.source, p.archived_at, p.created_at, p.updated_at
from public.user_profiles p
where p.operator_id = public.app_operator_id();

revoke all on public.client_cards from public, anon;
grant select on public.client_cards to authenticated;

-- ---------------------------------------------------------------------------
-- 4) New tables
-- ---------------------------------------------------------------------------

-- files: team reads and uploads; receipts are founder-only; founder archives.
drop policy if exists ops_read   on public.files;
drop policy if exists ops_insert on public.files;
drop policy if exists ops_update on public.files;
create policy ops_read on public.files for select
  using (operator_id = public.app_operator_id() and (kind <> 'receipt' or public.is_founder()));
create policy ops_insert on public.files for insert
  with check (operator_id = public.app_operator_id() and (kind <> 'receipt' or public.is_founder()));
create policy ops_update on public.files for update
  using (operator_id = public.app_operator_id() and public.is_founder());

-- intake_submissions: the whole team works the leads inbox.
drop policy if exists ops_read   on public.intake_submissions;
drop policy if exists ops_insert on public.intake_submissions;
drop policy if exists ops_update on public.intake_submissions;
create policy ops_read   on public.intake_submissions for select using (operator_id = public.app_operator_id());
create policy ops_insert on public.intake_submissions for insert with check (operator_id = public.app_operator_id());
create policy ops_update on public.intake_submissions for update
  using (operator_id = public.app_operator_id()) with check (operator_id = public.app_operator_id());

-- wa_messages: team reads. Written by Edge Functions (service role bypasses RLS).
drop policy if exists ops_read on public.wa_messages;
create policy ops_read on public.wa_messages for select using (operator_id = public.app_operator_id());

-- bookings: team reads; bots and founder write.
drop policy if exists ops_read   on public.bookings;
drop policy if exists ops_insert on public.bookings;
drop policy if exists ops_update on public.bookings;
create policy ops_read   on public.bookings for select using (operator_id = public.app_operator_id());
create policy ops_insert on public.bookings for insert
  with check (operator_id = public.app_operator_id() and public.is_founder());
create policy ops_update on public.bookings for update
  using (operator_id = public.app_operator_id() and public.is_founder());

-- bot_jobs: team reads the queue; changes go through the functions in 104.
drop policy if exists ops_read   on public.bot_jobs;
drop policy if exists ops_update on public.bot_jobs;
create policy ops_read   on public.bot_jobs for select using (operator_id = public.app_operator_id());
create policy ops_update on public.bot_jobs for update
  using (operator_id = public.app_operator_id() and public.is_founder());

-- app_settings, crypto_keys: team reads (keys: public key + LOCKED private key);
-- founder changes.
drop policy if exists ops_read   on public.app_settings;
drop policy if exists ops_update on public.app_settings;
create policy ops_read   on public.app_settings for select using (operator_id = public.app_operator_id());
create policy ops_update on public.app_settings for update
  using (operator_id = public.app_operator_id() and public.is_founder());

drop policy if exists ops_read   on public.crypto_keys;
drop policy if exists ops_insert on public.crypto_keys;
drop policy if exists ops_update on public.crypto_keys;
create policy ops_read   on public.crypto_keys for select using (operator_id = public.app_operator_id());
create policy ops_insert on public.crypto_keys for insert
  with check (operator_id = public.app_operator_id() and public.is_web_founder());
create policy ops_update on public.crypto_keys for update
  using (operator_id = public.app_operator_id() and public.is_web_founder());

-- notifications: staff see team alerts; founder sees all.
drop policy if exists ops_read   on public.notifications;
drop policy if exists ops_insert on public.notifications;
create policy ops_read on public.notifications for select
  using (operator_id = public.app_operator_id() and (audience = 'team' or public.is_founder()));
create policy ops_insert on public.notifications for insert
  with check (operator_id = public.app_operator_id() and public.is_founder());

-- notification_prefs: each person manages their own.
drop policy if exists ops_own on public.notification_prefs;
create policy ops_own on public.notification_prefs for all
  using (staff_id = public.auth_staff_id()) with check (staff_id = public.auth_staff_id());

-- security_questions: no secrets, readable by everyone; founder curates.
drop policy if exists ops_read   on public.security_questions;
drop policy if exists ops_insert on public.security_questions;
drop policy if exists ops_update on public.security_questions;
create policy ops_read   on public.security_questions for select using (true);
create policy ops_insert on public.security_questions for insert with check (public.is_founder());
create policy ops_update on public.security_questions for update using (public.is_founder());

-- Money tables: founder only. Staff record payments through record_payment() (104).
do $$
declare t text;
begin
  foreach t in array array['payments','price_list','expense_categories','recurring_expenses',
                           'expenses','founder_repayments']
  loop
    execute format('drop policy if exists ops_founder_read on public.%I', t);
    execute format('drop policy if exists ops_founder_insert on public.%I', t);
    execute format('drop policy if exists ops_founder_update on public.%I', t);
    execute format('create policy ops_founder_read on public.%I for select
                      using (operator_id = public.app_operator_id() and public.is_founder())', t);
    execute format('create policy ops_founder_insert on public.%I for insert
                      with check (operator_id = public.app_operator_id() and public.is_founder())', t);
    execute format('create policy ops_founder_update on public.%I for update
                      using (operator_id = public.app_operator_id() and public.is_founder())
                      with check (operator_id = public.app_operator_id() and public.is_founder())', t);
  end loop;
end $$;

-- audit_log: founder reads. Nobody writes directly (triggers do, in 103).
drop policy if exists ops_founder_read on public.audit_log;
create policy ops_founder_read on public.audit_log for select
  using (operator_id = public.app_operator_id() and public.is_founder());
revoke insert, update, delete, truncate on public.audit_log from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) Storage: bucket 'ops-files', paths '<operator_id>/<folder>/<file>'.
--    Receipts live under '<operator_id>/receipts/' and are founder-only.
--    No update or delete rules: files are never overwritten or removed.
-- ---------------------------------------------------------------------------
drop policy if exists ops_files_read   on storage.objects;
drop policy if exists ops_files_insert on storage.objects;
create policy ops_files_read on storage.objects for select
  using (bucket_id = 'ops-files'
         and (storage.foldername(name))[1] = public.app_operator_id()::text
         and ((storage.foldername(name))[2] <> 'receipts' or public.is_founder()));
create policy ops_files_insert on storage.objects for insert
  with check (bucket_id = 'ops-files'
              and (storage.foldername(name))[1] = public.app_operator_id()::text
              and ((storage.foldername(name))[2] <> 'receipts' or public.is_founder()));

-- ---------------------------------------------------------------------------
-- Verify: every new table has RLS on, and audit_log has no write rule.
-- ---------------------------------------------------------------------------
select c.relname as table_name, c.relrowsecurity as rls_on,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as rules
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('files','intake_submissions','wa_messages','payments','price_list',
                    'expense_categories','recurring_expenses','expenses','founder_repayments',
                    'bookings','bot_jobs','app_settings','crypto_keys','notifications',
                    'notification_prefs','audit_log','security_questions')
order by 1;
