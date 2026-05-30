# SUPABASE_SCHEMA.md — Cloud Tables

Supabase project: `sbuaojiamicreyysvnqj`. All writes scoped by `operator_id`. Credentials encrypted with the operator master password before storage. Access via `supabase-sync.js`.

---

## operators
Operator accounts. One operator runs many user profiles/devices.
- `id` (uuid, PK)
- (operator key validated via `get_operator_id()` Postgres fn using `x-operator-key` header)

## devices
Each Chrome profile that connects registers as a device.
- `id` (uuid, PK)
- `device_name` (text) — human label. TEST build prefixes `TEST-`.
- `last_seen` (timestamptz) — heartbeat. Dashboard uses this: if active user's device last_seen > 10 min → auto-mark idle (stale cleanup).
- `operator_id` (uuid)

## user_profiles
The visa booking clients. One row per username.
- `id` (uuid, PK)
- `operator_id` (uuid)
- `username` (text)
- `password_enc` (text, encrypted)
- `security_q1/q2/q3` (text) + `security_a1_enc/a2_enc/a3_enc` (encrypted)
- `visa_type` (text)
- `start_date`, `end_date` (date)
- `locations` (jsonb array) — e.g. `["Mumbai","Hyderabad"]`
- `applicant_count` (int), `price_per_person` (int), `agreed_price` (int)
- `auto_login`, `auto_dashboard`, `auto_select`, `auto_submit` (bool)
- `captcha_mode` (text)
- `status` (text) — `idle | logging_in | security_questions | on_dashboard | cycling | slot_found | confirmed | rate_limited | session_expired | error`
- `is_active` (bool) — currently running somewhere
- `active_device_id` (uuid) — which device runs it (null when idle)
- `active_device_name` (text) — readable device name (null when idle)
- `rate_limited_at` (timestamptz) — set when "exceeded limit" hit; dashboard blocks START for 24h then auto-clears
- `created_at`, `updated_at` (timestamptz)

## slot_history
Every slot detected.
- `id`, `operator_id`, `username`
- `location`, `date`, `in_range` (bool)
- `action` (text) — `detected | selected | submitted | confirmed`
- `found_at` (timestamptz)

## event_logs
Activity feed (login, dashboard, cycling, errors, etc.). Shared across devices → dashboards merge.
- `id`, `operator_id`, `username`, `type`, `message`, `metadata` (jsonb), `timestamp`

## request_stats
Rate-tracking (per 60s window). Written by rate tracker.
- `id` (bigint, PK), `device_name`, `username`
- `period_start`, `period_end` (timestamptz)
- `total_requests`, `successful_requests`, `blocked_requests` (int)
- `avg_delay_sec` (float)
- `locations_checked` (array), `error_types` (jsonb)

## daily_stats
Per-day/hour aggregates.
- `operator_id`, `device_id`, `username`, `stat_date`, `stat_hour`, `location`
- `rounds`, `slots_found`, `slots_in_range`, `missed`, `booked`, `errors`, `captcha_attempts`, `captcha_success`

---

## TEST build filtering
Test rows are identified by `device_name` starting with `TEST-`. Dashboard can filter these out from production view. No separate schema/columns.
