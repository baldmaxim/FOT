-- 024: Shared runtime state for Sigur polling/monitor leaders

BEGIN;

CREATE TABLE IF NOT EXISTS sigur_runtime_state (
  key TEXT PRIMARY KEY,
  checkpoint_at TIMESTAMPTZ NULL,
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  heartbeat_at TIMESTAMPTZ NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sigur_runtime_state_lease_expires_at
  ON sigur_runtime_state (lease_expires_at);

DROP FUNCTION IF EXISTS try_acquire_sigur_runtime_lease(TEXT, TEXT, INTEGER, JSONB);

CREATE FUNCTION try_acquire_sigur_runtime_lease(
  p_key TEXT,
  p_owner TEXT,
  p_ttl_seconds INTEGER,
  p_meta JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  state_key TEXT,
  state_checkpoint_at TIMESTAMPTZ,
  state_lease_owner TEXT,
  state_lease_expires_at TIMESTAMPTZ,
  state_heartbeat_at TIMESTAMPTZ,
  state_meta JSONB,
  state_updated_at TIMESTAMPTZ,
  acquired BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_expires_at TIMESTAMPTZ := v_now + make_interval(secs => GREATEST(COALESCE(p_ttl_seconds, 0), 1));
BEGIN
  INSERT INTO sigur_runtime_state AS state (
    key,
    checkpoint_at,
    lease_owner,
    lease_expires_at,
    heartbeat_at,
    meta,
    updated_at
  )
  VALUES (
    p_key,
    NULL,
    p_owner,
    v_expires_at,
    v_now,
    COALESCE(p_meta, '{}'::jsonb),
    v_now
  )
  ON CONFLICT (key) DO UPDATE
  SET
    lease_owner = EXCLUDED.lease_owner,
    lease_expires_at = EXCLUDED.lease_expires_at,
    heartbeat_at = EXCLUDED.heartbeat_at,
    meta = COALESCE(state.meta, '{}'::jsonb) || COALESCE(EXCLUDED.meta, '{}'::jsonb),
    updated_at = v_now
  WHERE state.lease_owner = p_owner
    OR state.lease_expires_at IS NULL
    OR state.lease_expires_at <= v_now;

  RETURN QUERY
  SELECT
    state.key,
    state.checkpoint_at,
    state.lease_owner,
    state.lease_expires_at,
    state.heartbeat_at,
    state.meta,
    state.updated_at,
    state.lease_owner = p_owner AND state.lease_expires_at > v_now AS acquired
  FROM sigur_runtime_state AS state
  WHERE state.key = p_key;
END;
$$;

DROP FUNCTION IF EXISTS heartbeat_sigur_runtime_lease(TEXT, TEXT, INTEGER, JSONB);

CREATE FUNCTION heartbeat_sigur_runtime_lease(
  p_key TEXT,
  p_owner TEXT,
  p_ttl_seconds INTEGER,
  p_meta JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  state_key TEXT,
  state_checkpoint_at TIMESTAMPTZ,
  state_lease_owner TEXT,
  state_lease_expires_at TIMESTAMPTZ,
  state_heartbeat_at TIMESTAMPTZ,
  state_meta JSONB,
  state_updated_at TIMESTAMPTZ,
  refreshed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_expires_at TIMESTAMPTZ := v_now + make_interval(secs => GREATEST(COALESCE(p_ttl_seconds, 0), 1));
BEGIN
  UPDATE sigur_runtime_state AS state
  SET
    lease_expires_at = v_expires_at,
    heartbeat_at = v_now,
    meta = COALESCE(state.meta, '{}'::jsonb) || COALESCE(p_meta, '{}'::jsonb),
    updated_at = v_now
  WHERE state.key = p_key
    AND state.lease_owner = p_owner
    AND state.lease_expires_at IS NOT NULL
    AND state.lease_expires_at > v_now;

  RETURN QUERY
  SELECT
    state.key,
    state.checkpoint_at,
    state.lease_owner,
    state.lease_expires_at,
    state.heartbeat_at,
    state.meta,
    state.updated_at,
    state.lease_owner = p_owner AND state.lease_expires_at > v_now AS refreshed
  FROM sigur_runtime_state AS state
  WHERE state.key = p_key;
END;
$$;

CREATE OR REPLACE FUNCTION merge_sigur_runtime_state(
  p_key TEXT,
  p_checkpoint_at TIMESTAMPTZ DEFAULT NULL,
  p_meta JSONB DEFAULT '{}'::jsonb,
  p_owner TEXT DEFAULT NULL
)
RETURNS sigur_runtime_state
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_result sigur_runtime_state;
BEGIN
  INSERT INTO sigur_runtime_state AS state (
    key,
    checkpoint_at,
    lease_owner,
    lease_expires_at,
    heartbeat_at,
    meta,
    updated_at
  )
  VALUES (
    p_key,
    p_checkpoint_at,
    NULL,
    NULL,
    NULL,
    COALESCE(p_meta, '{}'::jsonb),
    v_now
  )
  ON CONFLICT (key) DO UPDATE
  SET
    checkpoint_at = CASE
      WHEN p_checkpoint_at IS NULL THEN state.checkpoint_at
      WHEN state.checkpoint_at IS NULL THEN p_checkpoint_at
      WHEN p_checkpoint_at > state.checkpoint_at THEN p_checkpoint_at
      ELSE state.checkpoint_at
    END,
    meta = COALESCE(state.meta, '{}'::jsonb) || COALESCE(p_meta, '{}'::jsonb),
    updated_at = v_now
  WHERE p_owner IS NULL
    OR state.lease_owner IS NULL
    OR state.lease_owner = p_owner;

  SELECT state.*
  INTO v_result
  FROM sigur_runtime_state AS state
  WHERE state.key = p_key;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION release_sigur_runtime_lease(
  p_key TEXT,
  p_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rows_updated INTEGER := 0;
BEGIN
  UPDATE sigur_runtime_state AS state
  SET
    lease_owner = NULL,
    lease_expires_at = NULL,
    heartbeat_at = NULL,
    updated_at = NOW()
  WHERE state.key = p_key
    AND state.lease_owner = p_owner;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  RETURN v_rows_updated > 0;
END;
$$;

COMMIT;
