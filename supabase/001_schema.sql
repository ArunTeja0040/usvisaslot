-- ============================================================
-- US Visa Auto Booking — Supabase Schema
-- Run this in Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- 1. OPERATORS — You (and future operators)
CREATE TABLE operators (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  api_key     TEXT UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 2. DEVICES — Each Chrome profile/machine
CREATE TABLE devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   UUID REFERENCES operators(id) ON DELETE CASCADE NOT NULL,
  device_name   TEXT,
  chrome_profile TEXT,
  last_seen     TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 3. USER PROFILES — Visa applicant credentials & preferences
CREATE TABLE user_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     UUID REFERENCES operators(id) ON DELETE CASCADE NOT NULL,
  active_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  username        TEXT NOT NULL,
  password_enc    TEXT NOT NULL,
  security_q1     TEXT,
  security_a1_enc TEXT,
  security_q2     TEXT,
  security_a2_enc TEXT,
  security_q3     TEXT,
  security_a3_enc TEXT,
  visa_type       TEXT,
  start_date      DATE,
  end_date        DATE,
  locations       TEXT[],
  agreed_price    INTEGER,
  auto_login      BOOLEAN DEFAULT true,
  auto_dashboard  BOOLEAN DEFAULT true,
  auto_select     BOOLEAN DEFAULT true,
  auto_submit     BOOLEAN DEFAULT true,
  captcha_mode    TEXT DEFAULT 'auto',
  status          TEXT DEFAULT 'idle',
  is_active       BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(operator_id, username)
);

-- 4. SLOT HISTORY — Every slot detected (for prediction model)
CREATE TABLE slot_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   UUID REFERENCES operators(id) ON DELETE CASCADE NOT NULL,
  device_id     UUID REFERENCES devices(id) ON DELETE SET NULL,
  username      TEXT NOT NULL,
  location      TEXT NOT NULL,
  slot_date     DATE NOT NULL,
  action        TEXT NOT NULL,
  in_range      BOOLEAN DEFAULT false,
  round         INTEGER,
  detected_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_slot_history_lookup
  ON slot_history(operator_id, location, slot_date, detected_at);

CREATE INDEX idx_slot_history_prediction
  ON slot_history(location, slot_date, detected_at);

CREATE INDEX idx_slot_history_user
  ON slot_history(operator_id, username, detected_at DESC);

-- 5. EVENT LOGS — Activity log
CREATE TABLE event_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   UUID REFERENCES operators(id) ON DELETE CASCADE NOT NULL,
  device_id     UUID REFERENCES devices(id) ON DELETE SET NULL,
  username      TEXT,
  event_type    TEXT NOT NULL,
  message       TEXT NOT NULL,
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_event_logs_time
  ON event_logs(operator_id, created_at DESC);

CREATE INDEX idx_event_logs_type
  ON event_logs(operator_id, event_type, created_at DESC);

-- 6. DAILY STATS — Aggregated daily counters
CREATE TABLE daily_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     UUID REFERENCES operators(id) ON DELETE CASCADE NOT NULL,
  device_id       UUID REFERENCES devices(id) ON DELETE SET NULL,
  username        TEXT,
  stat_date       DATE NOT NULL,
  stat_hour       INTEGER,
  location        TEXT,
  rounds          INTEGER DEFAULT 0,
  slots_found     INTEGER DEFAULT 0,
  slots_in_range  INTEGER DEFAULT 0,
  missed          INTEGER DEFAULT 0,
  booked          INTEGER DEFAULT 0,
  errors          INTEGER DEFAULT 0,
  captcha_attempts INTEGER DEFAULT 0,
  captcha_success  INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(operator_id, device_id, username, stat_date, stat_hour, location)
);

CREATE INDEX idx_daily_stats_date
  ON daily_stats(operator_id, stat_date DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE slot_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_stats ENABLE ROW LEVEL SECURITY;

-- Helper function: get operator_id from API key passed in header
CREATE OR REPLACE FUNCTION get_operator_id() RETURNS UUID AS $$
  SELECT id FROM operators
  WHERE api_key = current_setting('request.headers', true)::json->>'x-operator-key'
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Operators can only read their own row
CREATE POLICY "operators_self" ON operators
  FOR SELECT USING (id = get_operator_id());

-- Devices: operator sees only their devices
CREATE POLICY "devices_read" ON devices
  FOR SELECT USING (operator_id = get_operator_id());
CREATE POLICY "devices_insert" ON devices
  FOR INSERT WITH CHECK (operator_id = get_operator_id());
CREATE POLICY "devices_update" ON devices
  FOR UPDATE USING (operator_id = get_operator_id());
CREATE POLICY "devices_delete" ON devices
  FOR DELETE USING (operator_id = get_operator_id());

-- User profiles: operator sees only their profiles
CREATE POLICY "profiles_read" ON user_profiles
  FOR SELECT USING (operator_id = get_operator_id());
CREATE POLICY "profiles_insert" ON user_profiles
  FOR INSERT WITH CHECK (operator_id = get_operator_id());
CREATE POLICY "profiles_update" ON user_profiles
  FOR UPDATE USING (operator_id = get_operator_id());
CREATE POLICY "profiles_delete" ON user_profiles
  FOR DELETE USING (operator_id = get_operator_id());

-- Slot history: operator sees only their slots
CREATE POLICY "slots_read" ON slot_history
  FOR SELECT USING (operator_id = get_operator_id());
CREATE POLICY "slots_insert" ON slot_history
  FOR INSERT WITH CHECK (operator_id = get_operator_id());

-- Event logs: operator sees only their events
CREATE POLICY "events_read" ON event_logs
  FOR SELECT USING (operator_id = get_operator_id());
CREATE POLICY "events_insert" ON event_logs
  FOR INSERT WITH CHECK (operator_id = get_operator_id());

-- Daily stats: operator sees only their stats
CREATE POLICY "stats_read" ON daily_stats
  FOR SELECT USING (operator_id = get_operator_id());
CREATE POLICY "stats_insert" ON daily_stats
  FOR INSERT WITH CHECK (operator_id = get_operator_id());
CREATE POLICY "stats_update" ON daily_stats
  FOR UPDATE USING (operator_id = get_operator_id());

-- ============================================================
-- AUTO-CLEANUP: delete event logs older than 30 days
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_old_events() RETURNS void AS $$
  DELETE FROM event_logs WHERE created_at < now() - interval '30 days';
$$ LANGUAGE sql;

-- ============================================================
-- AUTO-UPDATE updated_at on user_profiles
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- INSERT YOUR OPERATOR RECORD
-- Replace email and name with yours
-- ============================================================

INSERT INTO operators (email, name)
VALUES ('gannuarunteja@gmail.com', 'Arun Teja Gannu');

-- Run this after insert to get your API key:
-- SELECT api_key FROM operators WHERE email = 'gannuarunteja@gmail.com';
