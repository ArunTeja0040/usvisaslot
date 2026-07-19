-- ============================================================================
-- 02-staff-security.sql — Staff access rules (issue #50)
--
-- ⚠️  RUN ON THE **TEST** SUPABASE PROJECT FIRST. Run 01-staff-schema.sql before this.
--
-- SAFETY: every existing operator policy is left completely untouched. Postgres
-- combines permissive policies with OR, so adding staff rules CANNOT reduce or
-- change what the owner key can do. Owner behaviour stays identical.
--
-- THE SECURITY HINGE: staff must NEVER be given the operator key (x-operator-key).
-- With it they'd match the owner policies and see everything. Their invite must
-- carry only: supabase url + anon key + their staff key + operator_id + master password.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER so they bypass RLS internally and avoid recursion)
-- ---------------------------------------------------------------------------

-- Which operator does the calling staff member belong to?
create or replace function public.staff_operator_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select s.operator_id from public.staff s
  where s.id = public.get_staff_id();
$$;

-- Which client usernames is the calling staff member responsible for?
create or replace function public.staff_usernames()
returns setof text
language sql stable security definer set search_path = public
as $$
  select p.username from public.user_profiles p
  where p.assigned_staff_id = public.get_staff_id();
$$;

-- ---------------------------------------------------------------------------
-- 1) user_profiles — staff see/update ONLY their assigned clients
-- ---------------------------------------------------------------------------
drop policy if exists user_profiles_staff_read on public.user_profiles;
create policy user_profiles_staff_read on public.user_profiles
  for select
  using (assigned_staff_id is not null and assigned_staff_id = public.get_staff_id());

drop policy if exists user_profiles_staff_update on public.user_profiles;
create policy user_profiles_staff_update on public.user_profiles
  for update
  using      (assigned_staff_id is not null and assigned_staff_id = public.get_staff_id())
  with check (assigned_staff_id is not null and assigned_staff_id = public.get_staff_id());

-- No staff INSERT or DELETE policy → staff cannot add or remove clients.

-- ---------------------------------------------------------------------------
-- 2) Column-level limits for staff updates
--    RLS controls WHICH ROWS, not WHICH COLUMNS — without this a staff member
--    could reassign clients to themselves or edit credentials/pricing.
--    Staff may change ONLY: date range, cities, and the automation's own
--    runtime fields. Everything else is rejected.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_staff_update_limits()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Owner (operator key) is unrestricted; only staff callers are limited.
  if public.get_staff_id() is null then
    return new;
  end if;

  if new.assigned_staff_id  is distinct from old.assigned_staff_id
     or new.operator_id     is distinct from old.operator_id
     or new.username        is distinct from old.username
     or new.password_enc    is distinct from old.password_enc
     or new.security_q1     is distinct from old.security_q1
     or new.security_a1_enc is distinct from old.security_a1_enc
     or new.security_q2     is distinct from old.security_q2
     or new.security_a2_enc is distinct from old.security_a2_enc
     or new.security_q3     is distinct from old.security_q3
     or new.security_a3_enc is distinct from old.security_a3_enc
     or new.agreed_price     is distinct from old.agreed_price
     or new.price_per_person is distinct from old.price_per_person
     or new.applicant_count  is distinct from old.applicant_count
     or new.visa_type        is distinct from old.visa_type
  then
    raise exception 'Staff may only change the date range, cities and run status for their assigned clients.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_staff_update_limits on public.user_profiles;
create trigger trg_staff_update_limits
  before update on public.user_profiles
  for each row execute function public.enforce_staff_update_limits();

-- ---------------------------------------------------------------------------
-- 3) Devices — a staff member's Chrome must be able to register/heartbeat
-- ---------------------------------------------------------------------------
drop policy if exists devices_staff_read on public.devices;
create policy devices_staff_read on public.devices
  for select using (operator_id = public.staff_operator_id());

drop policy if exists devices_staff_insert on public.devices;
create policy devices_staff_insert on public.devices
  for insert with check (operator_id = public.staff_operator_id());

drop policy if exists devices_staff_update on public.devices;
create policy devices_staff_update on public.devices
  for update using (operator_id = public.staff_operator_id());

-- ---------------------------------------------------------------------------
-- 4) Logs / history / stats — staff read AND write, but only for their clients
--    (the automation writes these while a staff member runs a booking)
-- ---------------------------------------------------------------------------
drop policy if exists slot_history_staff_read on public.slot_history;
create policy slot_history_staff_read on public.slot_history
  for select using (public.get_staff_id() is not null
                    and username in (select public.staff_usernames()));

drop policy if exists slot_history_staff_insert on public.slot_history;
create policy slot_history_staff_insert on public.slot_history
  for insert with check (operator_id = public.staff_operator_id()
                         and username in (select public.staff_usernames()));

drop policy if exists event_logs_staff_read on public.event_logs;
create policy event_logs_staff_read on public.event_logs
  for select using (public.get_staff_id() is not null
                    and username in (select public.staff_usernames()));

drop policy if exists event_logs_staff_insert on public.event_logs;
create policy event_logs_staff_insert on public.event_logs
  for insert with check (operator_id = public.staff_operator_id()
                         and username in (select public.staff_usernames()));

drop policy if exists daily_stats_staff_read on public.daily_stats;
create policy daily_stats_staff_read on public.daily_stats
  for select using (public.get_staff_id() is not null
                    and username in (select public.staff_usernames()));

drop policy if exists daily_stats_staff_insert on public.daily_stats;
create policy daily_stats_staff_insert on public.daily_stats
  for insert with check (operator_id = public.staff_operator_id()
                         and username in (select public.staff_usernames()));

drop policy if exists daily_stats_staff_update on public.daily_stats;
create policy daily_stats_staff_update on public.daily_stats
  for update using (operator_id = public.staff_operator_id()
                    and username in (select public.staff_usernames()));

-- ---------------------------------------------------------------------------
-- Note: pricing is NOT hidden yet. price_per_person / agreed_price still exist
-- on user_profiles, so a staff key can still read them for their own clients.
-- They become truly invisible in step 03, which drops those columns after the
-- dashboard is switched over to the client_billing table.
-- ---------------------------------------------------------------------------
