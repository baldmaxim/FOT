-- Migration 014: иерархический чат, запросы на контакт и явные разрешения.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS chat_inbound_mode TEXT NOT NULL DEFAULT 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_profiles_chat_inbound_mode_check'
  ) THEN
    ALTER TABLE user_profiles
      ADD CONSTRAINT user_profiles_chat_inbound_mode_check
      CHECK (chat_inbound_mode IN ('open', 'requests_only', 'disabled'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chat_contact_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id   UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_by    UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (requester_id <> target_user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_contact_requests_requester
  ON chat_contact_requests (requester_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_contact_requests_target
  ON chat_contact_requests (target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_contact_requests_pending_target
  ON chat_contact_requests (target_user_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_contact_requests_pending_pair
  ON chat_contact_requests (requester_id, target_user_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS chat_contact_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id   UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  user_b_id   UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'manual',
  expires_at  TIMESTAMPTZ,
  created_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_a_id <> user_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_contact_grants_pair
  ON chat_contact_grants (user_a_id, user_b_id);

CREATE INDEX IF NOT EXISTS idx_chat_contact_grants_user_a
  ON chat_contact_grants (user_a_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_contact_grants_user_b
  ON chat_contact_grants (user_b_id, created_at DESC);
