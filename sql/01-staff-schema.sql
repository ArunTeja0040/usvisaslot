-- ============================================================================
-- 01-staff-schema.sql  —  Multi-user groundwork (issue #50)
--
-- ⚠️  RUN ON THE **TEST** SUPABASE PROJECT FIRST. Not production.
--
-- This script is ADDITIVE ONLY:
--   • creates two NEW tables
--   • adds ONE new nullable column
--   • adds ONE new function
--   • copies pricing into the new table (originals left untouched)
-- It does NOT enable/modify any security rules, and does NOT delete or rename
-- anything. Existing dashboard behaviour is unchanged after running it.
--
-- The security rules (who can see what) come in a SEPARATE script, written
-- after 00-inspect.sql shows how the current rules are set up.
--
-- Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Staff accounts
--    One row per hired person. `staff_key` is their secret — the extension
--    sends it as the `x-staff-key` header, mirroring the existing operator key.
-- ---------------------------------------------------------------------------
create table if not exists public.staff (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid        not null,
  name        text        not null,
  email       text,
  staff_key   text        not null unique,
  role        text        not null default 'staff' check (role in ('owner','staff')),
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_staff_operator on public.staff (operator_id);
create index if not exists idx_staff_key      on public.staff (staff_key);

comment on table  public.staff            is 'Hired staff who manage a subset of clients (issue #50).';
comment on column public.staff.staff_key  is 'Secret sent by the extension as the x-staff-key header. Deactivate to revoke access instantly.';

-- SECURITY: this table holds the staff secrets — lock it to the owner key immediately.
-- (A Supabase table with RLS disabled is readable by anyone holding the anon key.)
alter table public.staff enable row level security;

drop policy if exists staff_owner_all on public.staff;
create policy staff_owner_all on public.staff
  for all
  using      (operator_id = public.get_operator_id())
  with check (operator_id = public.get_operator_id());
-- Note: get_staff_id() is SECURITY DEFINER, so staff key lookups still work
-- even though staff themselves cannot read this table.

-- ---------------------------------------------------------------------------
-- 2) Which staff member owns which client
--    NULL = unassigned (visible to the owner only).
-- ---------------------------------------------------------------------------
alter table public.user_profiles
  add column if not exists assigned_staff_id uuid
  references public.staff (id) on delete set null;

create index if not exists idx_user_profiles_assigned
  on public.user_profiles (assigned_staff_id);

comment on column public.user_profiles.assigned_staff_id
  is 'Staff member responsible for this client. NULL = owner only (issue #50).';

-- ---------------------------------------------------------------------------
-- 3) "Who is calling?" for staff keys
--    Mirrors the existing get_operator_id() pattern. Returns NULL for anyone
--    who is not an active staff member.
-- ---------------------------------------------------------------------------
create or replace function public.get_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id
  from public.staff s
  where s.active
    and s.staff_key = nullif(
          current_setting('request.headers', true)::json ->> 'x-staff-key', ''
        )
  limit 1;
$$;

comment on function public.get_staff_id()
  is 'Resolves the x-staff-key request header to a staff id. NULL if missing/inactive (issue #50).';

-- ---------------------------------------------------------------------------
-- 4) Pricing moved to its own table (owner-only later)
--    Supabase cannot hide individual columns per user, so money lives in a
--    separate table that staff keys will simply have no access to.
--
--    NOTE: the original price columns on user_profiles are intentionally LEFT
--    IN PLACE for now, so today's dashboard keeps working. They get dropped
--    only after the dashboard reads from this table.
-- ---------------------------------------------------------------------------
create table if not exists public.client_billing (
  profile_id       uuid primary key references public.user_profiles (id) on delete cascade,
  operator_id      uuid        not null,
  price_per_person int,
  agreed_price     int,
  updated_at       timestamptz not null default now()
);

create index if not exists idx_client_billing_operator on public.client_billing (operator_id);

comment on table public.client_billing
  is 'Per-client pricing. Owner-only — staff keys get no access (issue #50).';

-- SECURITY: owner key only. Staff have no operator key, so they get nothing here.
alter table public.client_billing enable row level security;

drop policy if exists client_billing_owner_all on public.client_billing;
create policy client_billing_owner_all on public.client_billing
  for all
  using      (operator_id = public.get_operator_id())
  with check (operator_id = public.get_operator_id());

-- Copy existing pricing across (safe to re-run; never overwrites).
insert into public.client_billing (profile_id, operator_id, price_per_person, agreed_price)
select id, operator_id, price_per_person, agreed_price
from public.user_profiles
on conflict (profile_id) do nothing;

-- ---------------------------------------------------------------------------
-- Done. Verify:
-- ---------------------------------------------------------------------------
select 'staff rows'          as what, count(*) from public.staff
union all
select 'billing rows copied',       count(*) from public.client_billing
union all
select 'clients with assignment',   count(*) from public.user_profiles where assigned_staff_id is not null;
