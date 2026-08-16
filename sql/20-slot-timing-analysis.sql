-- ============================================================================
-- 20-slot-timing-analysis.sql — WHEN do slots actually appear? (timing intelligence)
--
-- Run in the PRODUCTION Supabase SQL editor. READ-ONLY — only SELECTs, nothing
-- is created, changed or deleted.
--
-- Why: the bot's request budget is limited (the site throttles us). Spending it
-- evenly around the clock is wasteful. If slots reliably drop in certain hours,
-- we scan hard in those windows and idle otherwise — being FIRST is what wins.
--
-- All times converted to IST (Asia/Kolkata).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) BY HOUR OF DAY — the headline. Which hours actually produce slots?
-- ---------------------------------------------------------------------------
select
  extract(hour from found_at at time zone 'Asia/Kolkata')::int as ist_hour,
  count(*)                                     as slots_seen,
  count(*) filter (where in_range)             as in_range,
  count(distinct date)                         as distinct_dates,
  count(distinct location)                     as locations
from public.slot_history
where found_at > now() - interval '90 days'
group by 1
order by slots_seen desc;

-- ---------------------------------------------------------------------------
-- 2) BY HOUR *PER CITY* — release windows often differ per consulate
-- ---------------------------------------------------------------------------
select
  location,
  extract(hour from found_at at time zone 'Asia/Kolkata')::int as ist_hour,
  count(*) as slots_seen
from public.slot_history
where found_at > now() - interval '90 days'
group by 1, 2
having count(*) >= 3            -- drop noise
order by location, slots_seen desc;

-- ---------------------------------------------------------------------------
-- 3) BY DAY OF WEEK — are there dead days worth idling through?
-- ---------------------------------------------------------------------------
select
  to_char(found_at at time zone 'Asia/Kolkata', 'Dy') as ist_day,
  extract(dow from found_at at time zone 'Asia/Kolkata')::int as dow,
  count(*) as slots_seen,
  count(*) filter (where in_range) as in_range
from public.slot_history
where found_at > now() - interval '90 days'
group by 1, 2
order by dow;

-- ---------------------------------------------------------------------------
-- 4) DAY x HOUR HEATMAP — the precise windows to scan hard
-- ---------------------------------------------------------------------------
select
  to_char(found_at at time zone 'Asia/Kolkata', 'Dy') as ist_day,
  extract(hour from found_at at time zone 'Asia/Kolkata')::int as ist_hour,
  count(*) as slots_seen
from public.slot_history
where found_at > now() - interval '90 days'
group by 1, 2
having count(*) >= 2
order by slots_seen desc
limit 40;

-- ---------------------------------------------------------------------------
-- 5) HOW WELL ARE WE CONVERTING? Detected vs actually booked.
--    If 'confirmed' is tiny next to 'detected', the loss is in the RACE, not
--    in detection — that changes what is worth optimising.
-- ---------------------------------------------------------------------------
select
  action,
  count(*) as n,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 1) as pct
from public.slot_history
where found_at > now() - interval '90 days'
group by action
order by n desc;

-- ---------------------------------------------------------------------------
-- 6) BURSTS — do slots arrive in clusters (a real "drop") or trickle in
--    (individual cancellations)? Counts slots seen per 10-minute bucket.
--    Many multi-slot buckets = real drops worth timing. Mostly 1s = cancellations,
--    which arrive randomly and can only be won by constant presence.
-- ---------------------------------------------------------------------------
with buckets as (
  select
    date_trunc('hour', found_at)
      + (floor(extract(minute from found_at) / 10) * interval '10 min') as bucket,
    location,
    count(*) as slots_in_bucket
  from public.slot_history
  where found_at > now() - interval '90 days'
  group by 1, 2
)
select
  slots_in_bucket,
  count(*) as how_many_such_buckets
from buckets
group by 1
order by slots_in_bucket desc
limit 20;

-- ---------------------------------------------------------------------------
-- 7) RECENT RAW SAMPLE — sanity-check the data looks right
-- ---------------------------------------------------------------------------
select
  to_char(found_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') as ist_time,
  location, date, in_range, action, username
from public.slot_history
order by found_at desc
limit 30;
