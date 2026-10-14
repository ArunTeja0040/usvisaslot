-- ============================================================================
-- 101_ops_core.sql — Ops Platform Phase 1: tables and columns (issue #79)
--
-- ⚠️  RUN ON THE **TEST** SUPABASE PROJECT FIRST. Not production.
-- ORDER: 101 → 102 → 103 → 104. Undo (test only): 199_undo_ops.sql
--
-- ADDITIVE ONLY: new tables, new nullable/defaulted columns, seed data.
-- Nothing existing is renamed, dropped or rewritten, so the current extension
-- keeps working exactly as today. Safe to run more than once.
--
-- Design: Technical Design § Data model
--   https://claude.ai/code/artifact/b8900e7b-050f-4cd4-b976-ec7872bce3c1
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Existing tables — new columns
-- ---------------------------------------------------------------------------

-- Clients. Leads live in intake_submissions until approved, so a client row
-- starts at 'approved'. Rows the extension creates get the same default.
alter table public.user_profiles
  add column if not exists phone_e164     text,
  add column if not exists whatsapp_name  text,
  add column if not exists stage          text not null default 'approved',
  add column if not exists payment_status text,
  add column if not exists travel_note    text,
  add column if not exists sec_q1_seen    text,
  add column if not exists sec_q2_seen    text,
  add column if not exists sec_q3_seen    text,
  add column if not exists archived_at    timestamptz,
  add column if not exists source         text not null default 'extension';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_stage_check') then
    alter table public.user_profiles add constraint user_profiles_stage_check
      check (stage in ('approved','advance_paid','hunting','booked','delivered','closed','cancelled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_payment_status_check') then
    -- NULL = not recorded (clients that existed before the platform)
    alter table public.user_profiles add constraint user_profiles_payment_status_check
      check (payment_status is null or payment_status in ('unpaid','advance_paid','fully_paid'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_source_check') then
    alter table public.user_profiles add constraint user_profiles_source_check
      check (source in ('extension','whatsapp','paste','manual'));
  end if;
end $$;

create index if not exists idx_user_profiles_phone on public.user_profiles (operator_id, phone_e164);
create index if not exists idx_user_profiles_stage on public.user_profiles (operator_id, stage) where archived_at is null;

-- One-time backfill of stage for clients that existed before this migration.
-- Only touches rows still on the column default, so re-running is harmless.
-- Runs only before 104 has installed the stage rules, i.e. on the first run.
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_user_profiles_stage') then
    update public.user_profiles
    set stage = case
                  when status = 'confirmed' then 'booked'
                  when is_active then 'hunting'
                  else 'approved'
                end
    where stage = 'approved';
  end if;
end $$;

-- Staff: web login link + pay. role 'owner' stays in the DB; the UI says Founder.
alter table public.staff
  add column if not exists auth_user_id    uuid unique references auth.users (id) on delete set null,
  add column if not exists pay_monthly     integer check (pay_monthly is null or pay_monthly >= 0),
  add column if not exists pay_per_booking integer check (pay_per_booking is null or pay_per_booking >= 0);

-- Founder-only pricing: the advance agreed with the client.
alter table public.client_billing
  add column if not exists advance_expected integer check (advance_expected is null or advance_expected >= 0);

-- Bots: which laptop a Chrome profile lives on, and whether it takes queue jobs.
alter table public.devices
  add column if not exists laptop_name    text,
  add column if not exists worker_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2) Files (created first: other tables point at it)
-- ---------------------------------------------------------------------------
create table if not exists public.files (
  id           uuid primary key default gen_random_uuid(),
  operator_id  uuid not null references public.operators (id),
  profile_id   uuid references public.user_profiles (id) on delete set null,
  kind         text not null check (kind in ('payment_screenshot','confirmation_pdf','receipt','whatsapp_media','other')),
  storage_path text not null unique,
  mime         text,
  size_bytes   integer,
  uploaded_by  uuid references public.staff (id) on delete set null,
  created_at   timestamptz not null default now(),
  archived_at  timestamptz
);
create index if not exists idx_files_profile on public.files (profile_id, created_at desc);

-- Private bucket for screenshots, PDFs and receipts. Access rules live in 102.
insert into storage.buckets (id, name, public)
values ('ops-files', 'ops-files', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3) Intake: parsed details messages (WhatsApp or Paste details)
-- ---------------------------------------------------------------------------
create table if not exists public.intake_submissions (
  id             uuid primary key default gen_random_uuid(),
  operator_id    uuid not null references public.operators (id),
  source         text not null check (source in ('whatsapp','paste')),
  wa_message_id  text unique,
  phone_e164     text,
  whatsapp_name  text,
  raw_redacted   text,                 -- original text with password/answers removed
  parsed         jsonb not null default '{}'::jsonb,  -- non-secret fields only
  secrets        jsonb,                -- locked (public-key) password + answers
  missing_fields text[] not null default '{}',
  confidence     numeric(4,3),
  status         text not null default 'new' check (status in ('new','needs_info','approved','rejected')),
  profile_id     uuid references public.user_profiles (id) on delete set null,
  reviewed_by    uuid references public.staff (id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists idx_intake_status on public.intake_submissions (operator_id, status, created_at desc);
create index if not exists idx_intake_phone  on public.intake_submissions (operator_id, phone_e164);

-- ---------------------------------------------------------------------------
-- 4) WhatsApp messages, both directions
-- ---------------------------------------------------------------------------
create table if not exists public.wa_messages (
  id            uuid primary key default gen_random_uuid(),
  operator_id   uuid not null references public.operators (id),
  wa_message_id text unique,
  phone_e164    text not null,
  direction     text not null check (direction in ('in','out')),
  msg_type      text not null,
  body_redacted text,
  file_id       uuid references public.files (id) on delete set null,
  profile_id    uuid references public.user_profiles (id) on delete set null,
  sent_by       uuid references public.staff (id) on delete set null,
  wa_timestamp  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_wa_messages_phone   on public.wa_messages (operator_id, phone_e164, created_at desc);
create index if not exists idx_wa_messages_profile on public.wa_messages (profile_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5) Money: payments, prices, expenses, founder repayments
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  operator_id        uuid not null references public.operators (id),
  profile_id         uuid not null references public.user_profiles (id),
  kind               text not null check (kind in ('advance','balance','other')),
  amount             integer not null check (amount > 0),
  method             text not null check (method in ('upi','bank','cash','other')),
  paid_on            date not null,
  screenshot_file_id uuid references public.files (id) on delete set null,
  note               text,
  recorded_by        uuid references public.staff (id) on delete set null,
  created_at         timestamptz not null default now(),
  archived_at        timestamptz
);
create index if not exists idx_payments_profile on public.payments (profile_id);
create index if not exists idx_payments_month   on public.payments (operator_id, paid_on);

create table if not exists public.price_list (
  operator_id     uuid not null references public.operators (id),
  visa_type       text not null,
  default_price   integer check (default_price is null or default_price >= 0),
  default_advance integer check (default_advance is null or default_advance >= 0),
  updated_at      timestamptz not null default now(),
  primary key (operator_id, visa_type)
);

create table if not exists public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id),
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (operator_id, name)
);

create table if not exists public.recurring_expenses (
  id                   uuid primary key default gen_random_uuid(),
  operator_id          uuid not null references public.operators (id),
  category_id          uuid not null references public.expense_categories (id),
  amount               integer not null check (amount > 0),
  vendor               text,
  note                 text,
  day_of_month         integer not null default 1 check (day_of_month between 1 and 28),
  staff_id             uuid references public.staff (id) on delete set null,
  paid_from            text not null default 'business' check (paid_from in ('business','founder_pocket')),
  active               boolean not null default true,
  last_generated_month date,
  created_at           timestamptz not null default now()
);

create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid not null references public.operators (id),
  spent_on        date not null,
  amount          integer not null check (amount > 0),
  category_id     uuid not null references public.expense_categories (id),
  vendor          text,
  note            text,
  receipt_file_id uuid references public.files (id) on delete set null,
  paid_from       text not null default 'business' check (paid_from in ('business','founder_pocket')),
  staff_id        uuid references public.staff (id) on delete set null,
  profile_id      uuid references public.user_profiles (id) on delete set null,  -- direct cost of a client
  recurring_id    uuid references public.recurring_expenses (id) on delete set null,
  created_by      uuid references public.staff (id) on delete set null,
  created_at      timestamptz not null default now(),
  archived_at     timestamptz
);
create index if not exists idx_expenses_month on public.expenses (operator_id, spent_on);
-- A recurring cost or a per-booking pay line is generated at most once.
create unique index if not exists uq_expenses_recurring_day
  on public.expenses (recurring_id, spent_on) where recurring_id is not null;
create unique index if not exists uq_expenses_booking_pay
  on public.expenses (profile_id, staff_id) where note = 'auto: per-booking pay';

create table if not exists public.founder_repayments (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id),
  repaid_on   date not null,
  amount      integer not null check (amount > 0),
  note        text,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 6) Bookings and the bot job queue
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  operator_id        uuid not null references public.operators (id),
  profile_id         uuid not null references public.user_profiles (id),
  ofc_at             timestamptz,
  ofc_location       text,
  interview_at       timestamptz,
  interview_location text,
  confirmed_at       timestamptz,
  pdf_file_id        uuid references public.files (id) on delete set null,
  pdf_status         text not null default 'pending' check (pdf_status in ('pending','saved','missing')),
  sent_to_client_at  timestamptz,
  sent_by            uuid references public.staff (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_bookings_profile on public.bookings (profile_id);

create table if not exists public.bot_jobs (
  id            uuid primary key default gen_random_uuid(),
  operator_id   uuid not null references public.operators (id),
  profile_id    uuid not null references public.user_profiles (id),
  action        text not null check (action in ('start','pause','stop','capture_pdf')),
  status        text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  priority      integer not null default 0,
  device_id     uuid references public.devices (id) on delete set null,
  claimed_at    timestamptz,
  heartbeat_at  timestamptz,
  slice_ends_at timestamptz,
  requeued_at   timestamptz,
  last_status   text,
  last_error    text,
  created_by    uuid references public.staff (id) on delete set null,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists idx_bot_jobs_queue on public.bot_jobs (operator_id, status, priority desc, created_at);
-- At most one open start job per client.
create unique index if not exists uq_bot_jobs_open_start
  on public.bot_jobs (profile_id) where action = 'start' and status in ('queued','running');

-- ---------------------------------------------------------------------------
-- 7) Settings, keys, alerts, audit
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  operator_id              uuid primary key references public.operators (id),
  job_slice_minutes        integer not null default 45 check (job_slice_minutes between 5 and 480),
  telegram_team_chat_id    text,
  telegram_founder_chat_id text,
  updated_at               timestamptz not null default now()
);

-- Public-key lock for client secrets. Empty until Phase 4 (bots must learn the
-- new format before anything is re-locked).
create table if not exists public.crypto_keys (
  operator_id        uuid primary key references public.operators (id),
  public_key_jwk     jsonb not null,
  private_key_locked jsonb not null,   -- private key, encrypted with the master password
  created_at         timestamptz not null default now(),
  rotated_at         timestamptz
);

create table if not exists public.notifications (
  id               uuid primary key default gen_random_uuid(),
  operator_id      uuid not null references public.operators (id),
  kind             text not null,
  audience         text not null default 'team' check (audience in ('team','founder')),
  title            text not null,
  body             text,
  profile_id       uuid references public.user_profiles (id) on delete set null,
  telegram_sent_at timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_notifications_recent on public.notifications (operator_id, created_at desc);

create table if not exists public.notification_prefs (
  staff_id uuid not null references public.staff (id) on delete cascade,
  kind     text not null,
  muted    boolean not null default true,
  primary key (staff_id, kind)
);

create table if not exists public.audit_log (
  id             bigint generated always as identity primary key,
  operator_id    uuid,
  at             timestamptz not null default now(),
  actor_staff_id uuid,
  actor_kind     text not null,
  action         text not null,
  table_name     text,
  row_id         text,
  before         jsonb,
  after          jsonb
);
create index if not exists idx_audit_recent on public.audit_log (operator_id, at desc);
create index if not exists idx_audit_row    on public.audit_log (table_name, row_id);

-- ---------------------------------------------------------------------------
-- 8) Security-question master list (no secrets — readable by everyone)
--    Starter list of common portal questions. Extend it with the real
--    questions already stored on clients:
--      select distinct security_q1 from user_profiles union
--      select distinct security_q2 from user_profiles union
--      select distinct security_q3 from user_profiles;
-- ---------------------------------------------------------------------------
create table if not exists public.security_questions (
  id         uuid primary key default gen_random_uuid(),
  question   text not null unique,
  keywords   text[] not null default '{}',
  verified   boolean not null default false,  -- true once seen on the real portal
  created_at timestamptz not null default now()
);

insert into public.security_questions (question, keywords) values
  ('What was the make of your first car?',                 array['first car','car make','frst car']),
  ('What is the name of the street you grew up on?',       array['street grew up','childhood street','street']),
  ('In what city did you meet your spouse?',               array['city met spouse','met spouse','spouse city','met wife','met husband']),
  ('What is the name of your first pet?',                  array['first pet','pet name','pet']),
  ('What is your mother''s maiden name?',                  array['mother maiden','maiden name','mom maiden']),
  ('In what city were you born?',                          array['birth city','city born','born city','birthplace']),
  ('What was the name of your elementary school?',         array['elementary school','primary school','first school']),
  ('What is the name of your favorite teacher?',           array['favorite teacher','fav teacher','favourite teacher']),
  ('What is your favorite movie?',                         array['favorite movie','fav movie','favourite film']),
  ('What is your father''s middle name?',                  array['father middle name','dad middle name']),
  ('What was your childhood nickname?',                    array['childhood nickname','nickname']),
  ('What is the name of your best friend from childhood?', array['childhood best friend','best friend']),
  ('In what city did your parents meet?',                  array['city parents met','parents met']),
  ('What was the name of your first employer?',            array['first employer','first company','first job'])
on conflict (question) do nothing;

-- ---------------------------------------------------------------------------
-- 9) Per-operator seed: expense categories and settings row
-- ---------------------------------------------------------------------------
insert into public.expense_categories (operator_id, name)
select o.id, c.name
from public.operators o
cross join (values ('Staff pay'), ('Notification services'), ('VPN and proxies'),
                   ('Hosting and database'), ('WhatsApp fees'), ('Internet and devices'),
                   ('Other')) as c(name)
on conflict (operator_id, name) do nothing;

insert into public.app_settings (operator_id)
select id from public.operators
on conflict (operator_id) do nothing;

-- ---------------------------------------------------------------------------
-- 10) Row-level security ON for every new table, before any rule exists.
--     (A table with RLS off is readable by anyone holding the anon key.)
--     The rules themselves are in 102_ops_security.sql.
-- ---------------------------------------------------------------------------
alter table public.files              enable row level security;
alter table public.intake_submissions enable row level security;
alter table public.wa_messages        enable row level security;
alter table public.payments           enable row level security;
alter table public.price_list         enable row level security;
alter table public.expense_categories enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.expenses           enable row level security;
alter table public.founder_repayments enable row level security;
alter table public.bookings           enable row level security;
alter table public.bot_jobs           enable row level security;
alter table public.app_settings       enable row level security;
alter table public.crypto_keys        enable row level security;
alter table public.notifications      enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.audit_log          enable row level security;
alter table public.security_questions enable row level security;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
select 'new ops tables' as what, count(*) as n
from information_schema.tables
where table_schema = 'public'
  and table_name in ('files','intake_submissions','wa_messages','payments','price_list',
                     'expense_categories','recurring_expenses','expenses','founder_repayments',
                     'bookings','bot_jobs','app_settings','crypto_keys','notifications',
                     'notification_prefs','audit_log','security_questions')
union all
select 'clients by stage: ' || stage, count(*) from public.user_profiles group by stage;
