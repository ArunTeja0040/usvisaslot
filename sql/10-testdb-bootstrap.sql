-- ============================================================================
-- 10-testdb-bootstrap.sql — build a mini copy of production on a FRESH,
-- EMPTY Supabase project so the staff rules (01 + 02) can be proven safely.
--
-- ⚠️  RUN THIS **ONLY** ON THE NEW EMPTY TEST PROJECT. Never on production —
--     it creates tables that already exist there.
--
-- It reproduces the same structure and the SAME operator security rules your
-- live database uses (operator_id = get_operator_id(), keyed off the
-- x-operator-key header), plus a little sample data to test with.
--
-- ORDER: run 10 (this) → 01-staff-schema → 02-staff-security → then test.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables (mirrors production structure)
-- ---------------------------------------------------------------------------
create table if not exists public.operators (
  id      uuid primary key default gen_random_uuid(),
  api_key text not null unique,
  name    text
);

create table if not exists public.user_profiles (
  id                 uuid primary key default gen_random_uuid(),
  operator_id        uuid not null,
  active_device_id   uuid,
  username           text not null,
  password_enc       text not null,
  security_q1        text, security_a1_enc text,
  security_q2        text, security_a2_enc text,
  security_q3        text, security_a3_enc text,
  visa_type          text,
  start_date         date,
  end_date           date,
  locations          text[],
  agreed_price       integer,
  auto_login         boolean,
  auto_dashboard     boolean,
  auto_select        boolean,
  auto_submit        boolean,
  captcha_mode       text,
  status             text,
  is_active          boolean,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  applicant_count    integer,
  price_per_person   integer,
  active_device_name text,
  rate_limited_at    timestamptz
);

create table if not exists public.devices (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  device_name text,
  last_seen   timestamptz default now()
);

create table if not exists public.slot_history (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  username    text,
  location    text,
  date        date,
  in_range    boolean,
  action      text,
  found_at    timestamptz default now()
);

create table if not exists public.event_logs (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  username    text,
  type        text,
  message     text,
  metadata    jsonb,
  timestamp   timestamptz default now()
);

create table if not exists public.daily_stats (
  id               uuid primary key default gen_random_uuid(),
  operator_id      uuid not null,
  device_id        uuid,
  username         text,
  stat_date        date,
  stat_hour        int,
  location         text,
  rounds           int default 0,
  slots_found      int default 0,
  slots_in_range   int default 0,
  missed           int default 0,
  booked           int default 0,
  errors           int default 0,
  captcha_attempts int default 0,
  captcha_success  int default 0
);

create table if not exists public.request_stats (
  id                  bigserial primary key,
  device_name         text,
  username            text,
  period_start        timestamptz,
  period_end          timestamptz,
  total_requests      int,
  successful_requests int,
  blocked_requests    int,
  avg_delay_sec       float,
  locations_checked   text[],
  error_types         jsonb
);

-- ---------------------------------------------------------------------------
-- The operator-key function — copied verbatim from production
-- ---------------------------------------------------------------------------
create or replace function public.get_operator_id()
returns uuid
language sql stable security definer
as $$
  select id from operators
  where api_key = current_setting('request.headers', true)::json->>'x-operator-key'
$$;

-- ---------------------------------------------------------------------------
-- The SAME operator policies production has today
-- ---------------------------------------------------------------------------
alter table public.operators     enable row level security;
alter table public.user_profiles enable row level security;
alter table public.devices       enable row level security;
alter table public.slot_history  enable row level security;
alter table public.event_logs    enable row level security;
alter table public.daily_stats   enable row level security;
alter table public.request_stats enable row level security;

drop policy if exists operators_self on public.operators;
create policy operators_self on public.operators
  for select using (id = public.get_operator_id());

drop policy if exists profiles_read   on public.user_profiles;
drop policy if exists profiles_insert on public.user_profiles;
drop policy if exists profiles_update on public.user_profiles;
drop policy if exists profiles_delete on public.user_profiles;
create policy profiles_read   on public.user_profiles for select using (operator_id = public.get_operator_id());
create policy profiles_insert on public.user_profiles for insert with check (operator_id = public.get_operator_id());
create policy profiles_update on public.user_profiles for update using (operator_id = public.get_operator_id());
create policy profiles_delete on public.user_profiles for delete using (operator_id = public.get_operator_id());

drop policy if exists devices_read   on public.devices;
drop policy if exists devices_insert on public.devices;
drop policy if exists devices_update on public.devices;
drop policy if exists "Allow delete for all" on public.devices;
create policy devices_read   on public.devices for select using (operator_id = public.get_operator_id());
create policy devices_insert on public.devices for insert with check (operator_id = public.get_operator_id());
create policy devices_update on public.devices for update using (operator_id = public.get_operator_id());
create policy "Allow delete for all" on public.devices for delete using (true);  -- mirrors production (see note)

drop policy if exists slots_read   on public.slot_history;
drop policy if exists slots_insert on public.slot_history;
create policy slots_read   on public.slot_history for select using (operator_id = public.get_operator_id());
create policy slots_insert on public.slot_history for insert with check (operator_id = public.get_operator_id());

drop policy if exists events_read   on public.event_logs;
drop policy if exists events_insert on public.event_logs;
create policy events_read   on public.event_logs for select using (operator_id = public.get_operator_id());
create policy events_insert on public.event_logs for insert with check (operator_id = public.get_operator_id());

drop policy if exists stats_read   on public.daily_stats;
drop policy if exists stats_insert on public.daily_stats;
drop policy if exists stats_update on public.daily_stats;
create policy stats_read   on public.daily_stats for select using (operator_id = public.get_operator_id());
create policy stats_insert on public.daily_stats for insert with check (operator_id = public.get_operator_id());
create policy stats_update on public.daily_stats for update using (operator_id = public.get_operator_id());

drop policy if exists "Allow read for all"   on public.request_stats;
drop policy if exists "Allow insert for all" on public.request_stats;
create policy "Allow read for all"   on public.request_stats for select using (true);   -- mirrors production (see note)
create policy "Allow insert for all" on public.request_stats for insert with check (true);

-- NOTE: the two `true` policies above are copied from production on purpose so
-- the test database behaves identically. They are pre-existing open rules and
-- should be tightened separately (tracked as its own issue).

-- ---------------------------------------------------------------------------
-- Sample data to test with
-- ---------------------------------------------------------------------------
insert into public.operators (api_key, name)
values ('TEST-OPERATOR-KEY-0001', 'Test Owner')
on conflict (api_key) do nothing;

insert into public.user_profiles (operator_id, username, password_enc, visa_type,
                                  start_date, end_date, locations,
                                  applicant_count, price_per_person, agreed_price, status)
select o.id, v.username, 'enc:dummy', 'H1B',
       current_date, current_date + 60, array['Mumbai','Hyderabad'],
       1, 20000, 20000, 'idle'
from public.operators o
cross join (values ('client_alpha'), ('client_beta'), ('client_gamma')) as v(username)
where o.api_key = 'TEST-OPERATOR-KEY-0001'
  and not exists (select 1 from public.user_profiles p where p.username = v.username);

-- ---------------------------------------------------------------------------
-- Copy these for testing
-- ---------------------------------------------------------------------------
select 'operator api_key' as what, api_key as value from public.operators where api_key = 'TEST-OPERATOR-KEY-0001'
union all
select 'operator_id', id::text from public.operators where api_key = 'TEST-OPERATOR-KEY-0001'
union all
select 'clients created', count(*)::text from public.user_profiles;
