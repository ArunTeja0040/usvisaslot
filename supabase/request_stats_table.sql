-- Run this in Supabase SQL Editor to create the request_stats table
-- Dashboard → SQL Editor → New Query → Paste → Run

CREATE TABLE IF NOT EXISTS request_stats (
  id BIGSERIAL PRIMARY KEY,
  device_name TEXT,
  username TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  total_requests INT DEFAULT 0,
  successful_requests INT DEFAULT 0,
  blocked_requests INT DEFAULT 0,
  avg_delay_sec FLOAT DEFAULT 0,
  locations_checked TEXT[] DEFAULT '{}',
  error_types JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast queries by username + time
CREATE INDEX IF NOT EXISTS idx_request_stats_user_time
  ON request_stats (username, period_start DESC);

-- Enable Row Level Security (match your existing tables' pattern)
ALTER TABLE request_stats ENABLE ROW LEVEL SECURITY;

-- Allow inserts from anon/authenticated (extension uses apikey)
CREATE POLICY "Allow insert for all" ON request_stats
  FOR INSERT WITH CHECK (true);

-- Allow read for all (for dashboard queries)
CREATE POLICY "Allow read for all" ON request_stats
  FOR SELECT USING (true);
