CREATE TABLE IF NOT EXISTS user_state (
  user_id text PRIMARY KEY,
  base_limit integer NOT NULL DEFAULT 100 CHECK (base_limit BETWEEN 1 AND 1000000),
  extra_quota integer NOT NULL DEFAULT 0 CHECK (extra_quota BETWEEN 0 AND 1000000),
  bypass_enabled boolean NOT NULL DEFAULT false,
  quota_balance integer NOT NULL DEFAULT 100,
  quota_epoch bigint NOT NULL DEFAULT 0,
  applied_control_revision bigint NOT NULL DEFAULT 0,
  event_version bigint NOT NULL DEFAULT 0,
  last_manual_reset_at timestamptz,
  last_request_at timestamptz,
  next_change_at timestamptz,
  as_of timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS due_quota ON user_state(next_change_at) WHERE next_change_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS quota_log (
  request_id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES user_state,
  quota_epoch bigint NOT NULL,
  admitted_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS quota_window ON quota_log(user_id, quota_epoch, admitted_at);
CREATE TABLE IF NOT EXISTS applied_commands (
  command_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  control_revision bigint NOT NULL,
  command jsonb NOT NULL,
  result jsonb NOT NULL,
  UNIQUE(user_id, control_revision)
);
CREATE TABLE IF NOT EXISTS event_outbox (
  event_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  user_version bigint NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  UNIQUE(user_id, user_version)
);
CREATE INDEX IF NOT EXISTS pending_events ON event_outbox(created_at) WHERE delivered_at IS NULL;

-- Every writer enters here first. The UPDATE serializes a user's accounting in
-- PostgreSQL; subsequent VOLATILE statements see commits made while it waited.
CREATE OR REPLACE FUNCTION begin_quota_accounting(p_user text) RETURNS user_state
LANGUAGE plpgsql VOLATILE AS $$
DECLARE s user_state; t timestamptz; reclaimed integer;
BEGIN
  INSERT INTO user_state(user_id) VALUES(p_user) ON CONFLICT DO NOTHING;
  UPDATE user_state SET event_version = event_version + 1
    WHERE user_id = p_user RETURNING * INTO s;
  t := clock_timestamp(); -- Must be sampled AFTER acquiring write ordering.
  WITH expired AS (
    DELETE FROM quota_log WHERE user_id = p_user AND quota_epoch = s.quota_epoch
      AND admitted_at <= t - interval '1 hour' RETURNING request_id
  ) SELECT count(*)::integer INTO reclaimed FROM expired;
  UPDATE user_state SET quota_balance = quota_balance + reclaimed, as_of = t
    WHERE user_id = p_user RETURNING * INTO s;
  RETURN s;
END $$;

-- Build the projection inside the same transaction as the decision. Negative
-- balance is debt after capacity reductions; only the public value is clamped.
CREATE OR REPLACE FUNCTION emit_quota_event(p_user text, p_kind text,
  p_allowed boolean DEFAULT NULL, p_request uuid DEFAULT NULL,
  p_bypassed boolean DEFAULT false, p_charged boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE s user_state; capacity integer; used integer; next_at timestamptz;
  retry_at timestamptz; payload jsonb; event_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO s FROM user_state WHERE user_id = p_user;
  capacity := s.base_limit + s.extra_quota;
  used := capacity - s.quota_balance;
  SELECT min(admitted_at) + interval '1 hour' INTO next_at FROM quota_log
    WHERE user_id = p_user AND quota_epoch = s.quota_epoch;
  IF used >= capacity THEN
    -- After a reduction, wait for used-capacity+1 charges, not just the oldest.
    SELECT admitted_at + interval '1 hour' INTO retry_at FROM quota_log
      WHERE user_id = p_user AND quota_epoch = s.quota_epoch
      ORDER BY admitted_at, request_id OFFSET (used - capacity) LIMIT 1;
  END IF;
  UPDATE user_state SET next_change_at = next_at WHERE user_id = p_user;
  payload := jsonb_build_object(
    'eventId', event_id, 'userId', p_user, 'userVersion', s.event_version,
    'policyRevision', s.applied_control_revision, 'baseLimit', s.base_limit,
    'extraQuota', s.extra_quota, 'capacity', capacity, 'used', used,
    'remaining', greatest(0, s.quota_balance), 'bypassEnabled', s.bypass_enabled,
    'nextChangeAt', next_at, 'nextAllowedAt', retry_at,
    'lastManualResetAt', s.last_manual_reset_at, 'lastRequestAt', s.last_request_at,
    'asOf', s.as_of, 'status', CASE WHEN used >= capacity THEN 'Exceeded'
      WHEN used >= capacity * 0.9 THEN 'Warning' ELSE 'OK' END,
    'kind', p_kind, 'allowed', p_allowed, 'requestId', p_request,
    'bypassed', p_bypassed, 'quotaCharged', p_charged);
  INSERT INTO event_outbox(event_id, user_id, user_version, payload)
    VALUES(event_id, p_user, s.event_version, payload);
  RETURN payload;
END $$;

CREATE OR REPLACE FUNCTION consume_quota(p_user text, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE s user_state; admitted boolean; charged boolean := false;
BEGIN
  s := begin_quota_accounting(p_user);
  IF s.bypass_enabled THEN
    admitted := true;
  ELSE
    UPDATE user_state SET quota_balance = quota_balance - 1
      WHERE user_id = p_user AND bypass_enabled = false AND quota_balance > 0;
    admitted := FOUND;
    charged := admitted;
    IF charged THEN
      INSERT INTO quota_log VALUES(p_request, p_user, s.quota_epoch, s.as_of);
    END IF;
  END IF;
  UPDATE user_state SET last_request_at = s.as_of WHERE user_id = p_user;
  RETURN emit_quota_event(p_user, 'decision', admitted, p_request,
    admitted AND s.bypass_enabled, charged);
END $$;

CREATE OR REPLACE FUNCTION refresh_quota(p_user text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM begin_quota_accounting(p_user);
  RETURN emit_quota_event(p_user, 'state');
END $$;

CREATE OR REPLACE FUNCTION apply_quota_command(p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE s user_state; old_receipt applied_commands; result jsonb;
  cmd_id uuid := (p_command->>'commandId')::uuid;
  uid text := p_command->>'userId'; revision bigint;
  action jsonb := p_command->'action'; kind text := action->>'type'; amount integer;
BEGIN
  -- The subtransaction rolls back the reserved version/reclamation on a replay.
  BEGIN
    s := begin_quota_accounting(uid);
    SELECT * INTO old_receipt FROM applied_commands WHERE command_id = cmd_id;
    IF FOUND THEN
      -- Legacy receipts included a caller-assigned revision. Match the actual
      -- action so retries remain safe across the synchronous-delivery upgrade.
      IF (old_receipt.command - 'revision') <> (p_command - 'revision') THEN RAISE EXCEPTION 'Command ID conflict' USING ERRCODE = '23514'; END IF;
      RAISE EXCEPTION 'Replay' USING ERRCODE = 'P1001';
    END IF;
    -- Revisions follow actual application order inside the data transaction.
    revision := s.applied_control_revision + 1;
    IF kind = 'limit' OR kind = 'extra-quota' THEN
      amount := (action->>'value')::integer;
      IF kind = 'limit' THEN
        UPDATE user_state SET base_limit = amount,
          quota_balance = quota_balance + amount - base_limit WHERE user_id = uid;
      ELSE
        UPDATE user_state SET extra_quota = amount,
          quota_balance = quota_balance + amount - extra_quota WHERE user_id = uid;
      END IF;
    ELSIF kind = 'bypass' THEN
      UPDATE user_state SET bypass_enabled = (action->>'value')::boolean WHERE user_id = uid;
    ELSIF kind = 'reset' THEN
      UPDATE user_state SET quota_epoch = quota_epoch + 1,
        quota_balance = base_limit + extra_quota, last_manual_reset_at = s.as_of WHERE user_id = uid;
    ELSE RAISE EXCEPTION 'Unknown action' USING ERRCODE = '23514';
    END IF;
    UPDATE user_state SET applied_control_revision = revision WHERE user_id = uid;
    result := jsonb_build_object('commandId', cmd_id, 'revision', revision,
      'state', emit_quota_event(uid, 'state'));
    INSERT INTO applied_commands VALUES(cmd_id, uid, revision, p_command, result);
    RETURN result;
  EXCEPTION WHEN SQLSTATE 'P1001' THEN
    SELECT a.result INTO result FROM applied_commands a WHERE command_id = cmd_id;
    RETURN result;
  END;
END $$;
