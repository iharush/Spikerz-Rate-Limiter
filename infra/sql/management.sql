CREATE TABLE IF NOT EXISTS observed_users (
  user_id text PRIMARY KEY,
  user_version bigint NOT NULL,
  state jsonb NOT NULL,
  last_request_at timestamptz,
  as_of timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  user_version bigint NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL,
  allowed boolean,
  bypassed boolean NOT NULL,
  quota_charged boolean NOT NULL,
  UNIQUE(user_id, user_version)
);
CREATE INDEX IF NOT EXISTS history_by_user ON events(user_id, occurred_at DESC, event_id);
CREATE INDEX IF NOT EXISTS analytics_window ON events(occurred_at) WHERE kind = 'decision';
-- A transactional singleton counter orders COMMITTED feed positions. A sequence
-- alone could expose position 12 before position 11 has committed.
CREATE TABLE IF NOT EXISTS feed_clock (id boolean PRIMARY KEY DEFAULT true CHECK (id), position bigint NOT NULL DEFAULT 0);
INSERT INTO feed_clock(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS browser_feed (
  position bigint PRIMARY KEY,
  event_id uuid UNIQUE NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS ingestion_health (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  received_at timestamptz NOT NULL,
  source jsonb NOT NULL
);
