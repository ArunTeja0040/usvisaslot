-- 06-date-rules.sql — #94
--
-- Per-client date rules: days the client cannot take, and how much warning they
-- need.
--
-- A client's window was only ever a start and an end date, so the bot would
-- take a slot while they were abroad, or three days out when they need two
-- weeks to arrange travel. The operator had to watch and intervene, which
-- defeats the point of an automatic booker.
--
-- `excluded_dates` holds the parsed, normalised result as a JSON array of
-- "YYYY-MM-DD" strings — not the operator's raw typing. Whatever they type is
-- parsed and echoed back in the dashboard before saving, so what lands here is
-- always unambiguous, and the booking path never has to parse anything.
--
-- `minimum_notice_days` is whole days between today and the appointment, below
-- which a slot is ignored. NULL or 0 means no minimum.
--
-- Safe to run more than once. Additive and nullable — a project that has not
-- run this keeps working exactly as before, with both rules simply absent.

alter table public.user_profiles
  add column if not exists excluded_dates      jsonb,
  add column if not exists minimum_notice_days integer;

comment on column public.user_profiles.excluded_dates is
  '#94 Dates this client cannot take, as a JSON array of YYYY-MM-DD strings. Parsed and normalised by the dashboard before it is written; the booking path reads it as-is.';
comment on column public.user_profiles.minimum_notice_days is
  '#94 Whole days between today and the appointment, below which a slot is ignored for this client. NULL or 0 means no minimum.';

-- Guard against a negative notice period arriving from a hand-edited row: it
-- would silently widen the window rather than narrow it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_profiles_minimum_notice_days_nonneg'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_minimum_notice_days_nonneg
      check (minimum_notice_days is null or minimum_notice_days >= 0);
  end if;
end $$;
