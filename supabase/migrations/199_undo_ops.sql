-- ============================================================================
-- 199_undo_ops.sql — remove everything 101–104 added (issue #79)
--
-- ⚠️  TEST PROJECT ONLY. This deletes the new tables AND their data
--     (payments, expenses, audit log...). Never run it on production.
--
-- Guard: refuses unless you type the confirmation line first, in the same run:
--     set ops.confirm_undo = 'yes';
-- Columns added to existing tables are dropped too; existing data is untouched.
-- ============================================================================

do $$
begin
  if coalesce(current_setting('ops.confirm_undo', true), '') <> 'yes' then
    raise exception 'Refusing to undo. Add the line  set ops.confirm_undo = ''yes'';  above this file and run again (TEST project only).';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job
    where jobname in ('ops-sweep-stalled-jobs','ops-recurring-expenses');
  end if;
end $$;

drop trigger if exists trg_user_profiles_stage on public.user_profiles;
drop trigger if exists trg_add_booking_pay    on public.user_profiles;
do $$
declare t text;
begin
  foreach t in array array['user_profiles','client_billing','staff','devices']
  loop
    execute format('drop trigger if exists trg_audit on public.%I', t);
  end loop;
end $$;

drop view if exists public.v_founder_pocket, public.v_monthly_profit, public.v_client_money, public.client_cards;

drop policy if exists ops_founder_read   on public.user_profiles;
drop policy if exists ops_founder_insert on public.user_profiles;
drop policy if exists ops_founder_update on public.user_profiles;
drop policy if exists ops_founder_all    on public.client_billing;
drop policy if exists ops_founder_read   on public.staff;
drop policy if exists ops_founder_insert on public.staff;
drop policy if exists ops_founder_update on public.staff;
drop policy if exists ops_team_read      on public.devices;
drop policy if exists ops_founder_update on public.devices;
drop policy if exists ops_team_read      on public.slot_history;
drop policy if exists ops_team_read      on public.event_logs;
drop policy if exists ops_founder_read   on public.daily_stats;
drop policy if exists ops_files_read     on storage.objects;
drop policy if exists ops_files_insert   on storage.objects;

drop table if exists public.audit_log, public.notification_prefs, public.notifications,
  public.crypto_keys, public.app_settings, public.bot_jobs, public.bookings,
  public.founder_repayments, public.expenses, public.recurring_expenses,
  public.expense_categories, public.price_list, public.payments, public.wa_messages,
  public.intake_submissions, public.files, public.security_questions cascade;

drop function if exists public.request_start(uuid, boolean), public.request_stop(uuid, boolean),
  public.force_stage(uuid, text, text), public.record_payment(uuid, text, integer, text, date, uuid, text),
  public.claim_job(uuid), public.heartbeat_job(uuid, text), public.finish_job(uuid, text, text),
  public.sweep_stalled_jobs(), public.generate_recurring_expenses(), public.apply_payment(),
  public.add_booking_pay(), public.enforce_stage_transition(), public.log_secret_view(uuid, text),
  public.audit_log_guard(), public.audit_row(), public.audit_write(uuid, text, text, text, jsonb, jsonb),
  public.audit_actor_kind(), public.app_operator_id(), public.is_web_founder(), public.is_founder(),
  public.auth_staff_id();

alter table public.user_profiles
  drop constraint if exists user_profiles_stage_check,
  drop constraint if exists user_profiles_payment_status_check,
  drop constraint if exists user_profiles_source_check,
  drop column if exists phone_e164, drop column if exists whatsapp_name, drop column if exists stage,
  drop column if exists payment_status, drop column if exists travel_note,
  drop column if exists sec_q1_seen, drop column if exists sec_q2_seen, drop column if exists sec_q3_seen,
  drop column if exists archived_at, drop column if exists source;
alter table public.staff
  drop column if exists auth_user_id, drop column if exists pay_monthly, drop column if exists pay_per_booking;
alter table public.client_billing drop column if exists advance_expected;
alter table public.devices drop column if exists laptop_name, drop column if exists worker_enabled;

select 'undo complete' as status;
