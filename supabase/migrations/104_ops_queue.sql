-- ============================================================================
-- 104_ops_queue.sql — Ops Platform Phase 1: stage rules, payments, bot queue
-- (issue #79)
--
-- ⚠️  RUN ON THE **TEST** SUPABASE PROJECT FIRST. Run 101, 102, 103 before this.
--
-- • Stage rules: a client only moves along the allowed path; no hunting
--   before the advance is recorded (founder override is possible and logged).
-- • Payments: staff record them through record_payment() without ever being
--   able to read amounts back; the client's payment status updates itself.
-- • Bot queue: request_start / request_stop for people; claim_job /
--   heartbeat_job / finish_job for bots; a sweep re-queues stalled jobs.
-- • Money automation: per-booking staff pay and monthly recurring costs.
-- Nothing here is used by the current extension yet (that is Phase 4).
-- Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Stage rules
-- ---------------------------------------------------------------------------
create or replace function public.enforce_stage_transition()
returns trigger
language plpgsql
as $$
begin
  if new.stage is not distinct from old.stage then
    return new;
  end if;
  if coalesce(current_setting('ops.allow_any_stage', true), '') = 'on' then
    return new;  -- founder override via force_stage() / request_start(override)
  end if;
  if (old.stage, new.stage) in (
       ('approved',     'advance_paid'), ('approved',     'cancelled'),
       ('advance_paid', 'hunting'),      ('advance_paid', 'cancelled'),
       ('hunting',      'advance_paid'), ('hunting',      'booked'),   ('hunting', 'cancelled'),
       ('booked',       'delivered'),    ('booked',       'hunting'),
       ('delivered',    'closed')) then
    return new;
  end if;
  raise exception 'A client cannot move from % to %.', old.stage, new.stage;
end;
$$;

drop trigger if exists trg_user_profiles_stage on public.user_profiles;
create trigger trg_user_profiles_stage
  before update of stage on public.user_profiles
  for each row execute function public.enforce_stage_transition();

-- Founder-only: move a client to any stage, with a reason (kept in the audit log).
create or replace function public.force_stage(p_profile uuid, p_stage text, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_old text;
begin
  if not public.is_web_founder() then
    raise exception 'Only the founder can override a stage.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for the override.';
  end if;
  select stage into v_old from public.user_profiles
  where id = p_profile and operator_id = public.app_operator_id()
  for update;
  if not found then raise exception 'Client not found.'; end if;

  perform set_config('ops.allow_any_stage', 'on', true);
  update public.user_profiles set stage = p_stage where id = p_profile;
  perform set_config('ops.allow_any_stage', 'off', true);

  perform public.audit_write(public.app_operator_id(), 'stage_override', 'user_profiles',
                             p_profile::text, jsonb_build_object('stage', v_old),
                             jsonb_build_object('stage', p_stage, 'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Payments
-- ---------------------------------------------------------------------------

-- Keeps user_profiles.payment_status (and the approved → advance_paid step)
-- in line with what has been received.
create or replace function public.apply_payment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_price integer;
  v_paid  integer;
begin
  select coalesce(b.agreed_price, p.agreed_price) into v_price
  from public.user_profiles p
  left join public.client_billing b on b.profile_id = p.id
  where p.id = new.profile_id;

  select coalesce(sum(amount), 0) into v_paid
  from public.payments
  where profile_id = new.profile_id and archived_at is null;

  update public.user_profiles
  set payment_status = case
                         when v_paid = 0 then 'unpaid'
                         when v_price is not null and v_paid >= v_price then 'fully_paid'
                         else 'advance_paid'
                       end,
      stage = case when stage = 'approved' and v_paid > 0 then 'advance_paid' else stage end
  where id = new.profile_id;
  return null;
end;
$$;

drop trigger if exists trg_apply_payment on public.payments;
create trigger trg_apply_payment
  after insert or update on public.payments
  for each row execute function public.apply_payment();

-- Founder or staff record a payment. Staff cannot read payments back; this
-- returns only the new id.
create or replace function public.record_payment(
  p_profile uuid, p_kind text, p_amount integer, p_method text, p_paid_on date,
  p_screenshot_file uuid default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid := public.app_operator_id();
  v_id uuid;
begin
  if v_op is null then raise exception 'Not signed in.'; end if;
  if not exists (select 1 from public.user_profiles
                 where id = p_profile and operator_id = v_op and archived_at is null) then
    raise exception 'Client not found.';
  end if;
  insert into public.payments (operator_id, profile_id, kind, amount, method, paid_on,
                               screenshot_file_id, note, recorded_by)
  values (v_op, p_profile, p_kind, p_amount, p_method, p_paid_on,
          p_screenshot_file, p_note, public.auth_staff_id())
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Queue — people
-- ---------------------------------------------------------------------------

-- Start hunting. Refused before the advance is recorded unless the founder
-- overrides. Returns the start job id (the existing one if already queued).
create or replace function public.request_start(p_profile uuid, p_override boolean default false)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_op    uuid := public.app_operator_id();
  v_stage text;
  v_job   uuid;
begin
  if v_op is null then raise exception 'Not signed in.'; end if;

  select stage into v_stage from public.user_profiles
  where id = p_profile and operator_id = v_op and archived_at is null
  for update;
  if not found then raise exception 'Client not found.'; end if;

  if v_stage not in ('advance_paid','hunting') then
    if not (p_override and public.is_founder()) then
      raise exception 'Mark the advance as paid before hunting (client is in stage %).', v_stage;
    end if;
    perform set_config('ops.allow_any_stage', 'on', true);
    perform public.audit_write(v_op, 'start_override', 'user_profiles', p_profile::text,
                               jsonb_build_object('stage', v_stage), jsonb_build_object('stage', 'hunting'));
  end if;

  if v_stage <> 'hunting' then
    update public.user_profiles set stage = 'hunting' where id = p_profile;
  end if;
  perform set_config('ops.allow_any_stage', 'off', true);

  insert into public.bot_jobs (operator_id, profile_id, action, created_by)
  values (v_op, p_profile, 'start', public.auth_staff_id())
  on conflict (profile_id) where action = 'start' and status in ('queued','running') do nothing
  returning id into v_job;

  if v_job is null then
    select id into v_job from public.bot_jobs
    where profile_id = p_profile and action = 'start' and status in ('queued','running');
  end if;
  return v_job;
end;
$$;

-- Pause (keep the client in hunting, free the bot) or Stop (back to advance_paid).
create or replace function public.request_stop(p_profile uuid, p_pause boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op  uuid := public.app_operator_id();
  v_job public.bot_jobs;
begin
  if v_op is null then raise exception 'Not signed in.'; end if;
  if not exists (select 1 from public.user_profiles where id = p_profile and operator_id = v_op) then
    raise exception 'Client not found.';
  end if;

  select * into v_job from public.bot_jobs
  where profile_id = p_profile and action = 'start' and status in ('queued','running')
  for update;

  if found and v_job.status = 'queued' then
    update public.bot_jobs
    set status = 'cancelled', finished_at = now(),
        last_status = case when p_pause then 'paused' else 'stopped' end
    where id = v_job.id;
  elsif found and v_job.status = 'running' then
    -- The bot running it picks this up on its next heartbeat.
    insert into public.bot_jobs (operator_id, profile_id, action, created_by)
    values (v_op, p_profile, case when p_pause then 'pause' else 'stop' end, public.auth_staff_id());
  end if;

  if not p_pause then
    update public.user_profiles set stage = 'advance_paid'
    where id = p_profile and stage = 'hunting';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Queue — bots (operator key only)
-- ---------------------------------------------------------------------------

-- Hand this bot its next job, or nothing. One client per bot at a time.
create or replace function public.claim_job(p_device uuid)
returns setof public.bot_jobs
language plpgsql security definer set search_path = public
as $$
declare
  v_op    uuid := public.get_operator_id();
  v_slice integer;
  v_id    uuid;
begin
  if v_op is null then raise exception 'Bots only.'; end if;
  if not exists (select 1 from public.devices
                 where id = p_device and operator_id = v_op and worker_enabled) then
    raise exception 'This Chrome profile is not enabled as a bot.';
  end if;
  if exists (select 1 from public.bot_jobs
             where device_id = p_device and status = 'running') then
    return;  -- busy: it learns about pause/stop through heartbeat_job()
  end if;

  select coalesce(job_slice_minutes, 45) into v_slice
  from public.app_settings where operator_id = v_op;

  select id into v_id from public.bot_jobs
  where operator_id = v_op and status = 'queued' and action in ('start','capture_pdf')
  order by priority desc, coalesce(requeued_at, created_at)
  limit 1
  for update skip locked;
  if v_id is null then return; end if;

  return query
  update public.bot_jobs
  set status = 'running', device_id = p_device, claimed_at = now(), heartbeat_at = now(),
      slice_ends_at = now() + make_interval(mins => coalesce(v_slice, 45)), last_error = null
  where id = v_id
  returning *;
end;
$$;

-- Called every ~60 s by the bot. Answers: continue | yield | pause | stop.
create or replace function public.heartbeat_job(p_job uuid, p_status text default null)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_op   uuid := public.get_operator_id();
  v_job  public.bot_jobs;
  v_ctrl public.bot_jobs;
begin
  if v_op is null then raise exception 'Bots only.'; end if;

  select * into v_job from public.bot_jobs
  where id = p_job and operator_id = v_op
  for update;
  if not found or v_job.status <> 'running' then
    return 'stop';  -- cancelled, swept or finished elsewhere
  end if;

  -- A person asked to pause or stop this client?
  select * into v_ctrl from public.bot_jobs
  where profile_id = v_job.profile_id and action in ('pause','stop') and status = 'queued'
  order by created_at
  limit 1
  for update;
  if found then
    update public.bot_jobs set status = 'done', finished_at = now(), device_id = v_job.device_id
    where id = v_ctrl.id;
    update public.bot_jobs
    set status = 'cancelled', finished_at = now(), heartbeat_at = now(),
        last_status = case when v_ctrl.action = 'pause' then 'paused' else 'stopped' end
    where id = v_job.id;
    return v_ctrl.action;
  end if;

  -- A slot in range or a booking in progress: never hand the bot over mid-way.
  update public.bot_jobs
  set heartbeat_at = now(),
      last_status = coalesce(p_status, last_status),
      slice_ends_at = case when p_status in ('slot_found','booking') then null else slice_ends_at end
  where id = v_job.id
  returning * into v_job;

  if v_job.slice_ends_at is not null and now() > v_job.slice_ends_at
     and exists (select 1 from public.bot_jobs
                 where operator_id = v_op and status = 'queued' and action = 'start') then
    return 'yield';
  end if;
  return 'continue';
end;
$$;

-- The bot is done with a job: yield (back of the queue), booked, or failed.
create or replace function public.finish_job(p_job uuid, p_outcome text, p_error text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op  uuid := public.get_operator_id();
  v_job public.bot_jobs;
begin
  if v_op is null then raise exception 'Bots only.'; end if;
  select * into v_job from public.bot_jobs where id = p_job and operator_id = v_op for update;
  if not found then raise exception 'Job not found.'; end if;

  if p_outcome = 'yield' then
    update public.bot_jobs
    set status = 'queued', device_id = null, claimed_at = null, slice_ends_at = null,
        requeued_at = now(), last_status = 'waiting for a bot'
    where id = p_job;
  elsif p_outcome = 'booked' then
    update public.bot_jobs set status = 'done', finished_at = now(), last_status = 'booked'
    where id = p_job;
    update public.user_profiles set stage = 'booked'
    where id = v_job.profile_id and stage = 'hunting';
    insert into public.notifications (operator_id, kind, audience, title, profile_id)
    values (v_op, 'booked', 'team', 'Appointment booked', v_job.profile_id);
  elsif p_outcome = 'failed' then
    update public.bot_jobs set status = 'failed', finished_at = now(), last_error = p_error
    where id = p_job;
    insert into public.notifications (operator_id, kind, audience, title, body, profile_id)
    values (v_op, 'needs_help', 'team', 'Bot needs help', p_error, v_job.profile_id);
  else
    raise exception 'Unknown outcome: % (use yield, booked or failed)', p_outcome;
  end if;
end;
$$;

-- Every 5 minutes: jobs with no heartbeat for 10 minutes go back in the queue.
create or replace function public.sweep_stalled_jobs()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer;
begin
  with stalled as (
    update public.bot_jobs
    set status = 'queued', device_id = null, claimed_at = null, slice_ends_at = null,
        requeued_at = now(), last_error = 'stalled: no heartbeat for 10 minutes'
    where status = 'running' and heartbeat_at < now() - interval '10 minutes'
    returning operator_id, profile_id
  ), alerts as (
    insert into public.notifications (operator_id, kind, audience, title, profile_id)
    select operator_id, 'bot_stalled', 'founder', 'A bot stopped responding; client re-queued', profile_id
    from stalled
    returning 1
  )
  select count(*) into v_count from alerts;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Money automation
-- ---------------------------------------------------------------------------

-- On Booked: one per-booking pay line for the assigned staff member.
create or replace function public.add_booking_pay()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_rate integer;
  v_cat  uuid;
begin
  if new.stage <> 'booked' or old.stage = 'booked' or new.assigned_staff_id is null then
    return null;
  end if;
  select pay_per_booking into v_rate from public.staff where id = new.assigned_staff_id;
  if coalesce(v_rate, 0) <= 0 then return null; end if;

  select id into v_cat from public.expense_categories
  where operator_id = new.operator_id and name = 'Staff pay';
  if v_cat is null then
    insert into public.expense_categories (operator_id, name) values (new.operator_id, 'Staff pay')
    returning id into v_cat;
  end if;

  insert into public.expenses (operator_id, spent_on, amount, category_id, staff_id, profile_id, note)
  values (new.operator_id, current_date, v_rate, v_cat, new.assigned_staff_id, new.id,
          'auto: per-booking pay')
  on conflict (profile_id, staff_id) where note = 'auto: per-booking pay' do nothing;
  return null;
end;
$$;

drop trigger if exists trg_add_booking_pay on public.user_profiles;
create trigger trg_add_booking_pay
  after update of stage on public.user_profiles
  for each row execute function public.add_booking_pay();

-- Daily: create this month's row for each recurring cost once its day arrives.
create or replace function public.generate_recurring_expenses()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_month date := date_trunc('month', current_date)::date;
  v_count integer;
begin
  with due as (
    select * from public.recurring_expenses
    where active
      and day_of_month <= extract(day from current_date)
      and (last_generated_month is null or last_generated_month < v_month)
    for update
  ), made as (
    insert into public.expenses (operator_id, spent_on, amount, category_id, vendor, note,
                                 paid_from, staff_id, recurring_id)
    select operator_id, v_month + (day_of_month - 1), amount, category_id, vendor, note,
           paid_from, staff_id, id
    from due
    on conflict (recurring_id, spent_on) where recurring_id is not null do nothing
    returning recurring_id
  ), marked as (
    update public.recurring_expenses r set last_generated_month = v_month
    from due where r.id = due.id
    returning 1
  )
  select count(*) into v_count from made;  -- 'marked' runs too: data-modifying CTEs always execute
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Founder money views (security_invoker: the founder-only rules apply)
-- ---------------------------------------------------------------------------
create or replace view public.v_client_money
with (security_invoker = true) as
select p.id as profile_id, p.operator_id, p.username,
       coalesce(b.agreed_price, p.agreed_price) as agreed_price,
       coalesce(sum(pay.amount) filter (where pay.archived_at is null), 0)::integer as paid_total,
       (coalesce(b.agreed_price, p.agreed_price)
        - coalesce(sum(pay.amount) filter (where pay.archived_at is null), 0))::integer as balance_due
from public.user_profiles p
left join public.client_billing b on b.profile_id = p.id
left join public.payments pay on pay.profile_id = p.id
group by p.id, p.operator_id, p.username, b.agreed_price, p.agreed_price;

create or replace view public.v_monthly_profit
with (security_invoker = true) as
with money_in as (
  select operator_id, date_trunc('month', paid_on)::date as month, sum(amount)::bigint as amount
  from public.payments where archived_at is null group by 1, 2
), money_out as (
  select operator_id, date_trunc('month', spent_on)::date as month, sum(amount)::bigint as amount
  from public.expenses where archived_at is null group by 1, 2
)
select coalesce(i.operator_id, o.operator_id) as operator_id,
       coalesce(i.month, o.month) as month,
       coalesce(i.amount, 0) as money_in,
       coalesce(o.amount, 0) as money_out,
       coalesce(i.amount, 0) - coalesce(o.amount, 0) as profit
from money_in i
full join money_out o on o.operator_id = i.operator_id and o.month = i.month;

create or replace view public.v_founder_pocket
with (security_invoker = true) as
select o.id as operator_id,
       coalesce((select sum(amount) from public.expenses e
                 where e.operator_id = o.id and e.paid_from = 'founder_pocket' and e.archived_at is null), 0)::bigint as paid_personally,
       coalesce((select sum(amount) from public.founder_repayments r
                 where r.operator_id = o.id and r.archived_at is null), 0)::bigint as repaid,
       coalesce((select sum(amount) from public.expenses e
                 where e.operator_id = o.id and e.paid_from = 'founder_pocket' and e.archived_at is null), 0)::bigint
     - coalesce((select sum(amount) from public.founder_repayments r
                 where r.operator_id = o.id and r.archived_at is null), 0)::bigint as owed_to_founder
from public.operators o
where o.id = public.app_operator_id() and public.is_founder();

revoke all on public.v_client_money, public.v_monthly_profit, public.v_founder_pocket from public, anon;
grant select on public.v_client_money, public.v_monthly_profit, public.v_founder_pocket to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Who may call what
-- ---------------------------------------------------------------------------
revoke execute on function public.sweep_stalled_jobs()          from public, anon, authenticated;
revoke execute on function public.generate_recurring_expenses() from public, anon, authenticated;
revoke execute on function public.apply_payment()               from public, anon, authenticated;
revoke execute on function public.add_booking_pay()             from public, anon, authenticated;
-- Web-only (people):
revoke execute on function public.force_stage(uuid, text, text) from public, anon;
grant  execute on function public.force_stage(uuid, text, text) to authenticated;
-- Bots use the anon key + operator header, so these stay callable by anon;
-- each function checks the caller itself.

-- ---------------------------------------------------------------------------
-- 8) Schedules (needs the pg_cron extension: Database → Extensions → pg_cron)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ops-sweep-stalled-jobs', '*/5 * * * *', 'select public.sweep_stalled_jobs()');
    perform cron.schedule('ops-recurring-expenses', '15 0 * * *', 'select public.generate_recurring_expenses()');
  else
    raise notice 'pg_cron is not enabled. Enable it in Database → Extensions, then run this file again.';
  end if;
end $$;

-- Verify
select proname as function_name
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('request_start','request_stop','force_stage','record_payment','claim_job',
                  'heartbeat_job','finish_job','sweep_stalled_jobs','generate_recurring_expenses')
order by 1;
