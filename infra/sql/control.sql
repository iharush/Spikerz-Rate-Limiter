-- Audit and idempotency only. Commands are sent during the admin HTTP request;
-- no worker scans this table and no requested policy is stored separately.
CREATE TABLE IF NOT EXISTS commands (
  command_id uuid PRIMARY KEY,
  idempotency_key text UNIQUE NOT NULL,
  user_id text NOT NULL,
  revision bigint,
  action jsonb NOT NULL,
  actor_id text NOT NULL,
  status text NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed','applied','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  last_error text,
  result jsonb
);

-- Upgrade the earlier queued-command schema without losing audit records.
-- Previously pending work is retained for explicit retries, never dispatched.
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_user_id_fkey;
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_user_id_revision_key;
ALTER TABLE commands ALTER COLUMN revision DROP NOT NULL;
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_status_check;
UPDATE commands SET status='unconfirmed',
  last_error='Legacy queued command has no confirmed outcome. Retry explicitly with the same Idempotency-Key.'
  WHERE status='pending';
UPDATE commands SET revision=NULL WHERE status<>'applied';
ALTER TABLE commands ADD CONSTRAINT commands_status_check CHECK (status IN ('unconfirmed','applied','failed'));
ALTER TABLE commands ALTER COLUMN status SET DEFAULT 'unconfirmed';
DROP INDEX IF EXISTS command_dispatch;
ALTER TABLE commands DROP COLUMN IF EXISTS fingerprint;
ALTER TABLE commands DROP COLUMN IF EXISTS attempts;
ALTER TABLE commands DROP COLUMN IF EXISTS next_attempt_at;
DROP TABLE IF EXISTS desired_policies;
CREATE INDEX IF NOT EXISTS commands_by_user ON commands(user_id,created_at DESC);
