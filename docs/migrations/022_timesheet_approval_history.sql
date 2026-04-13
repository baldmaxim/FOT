-- 022_timesheet_approval_history.sql
-- Журнал истории согласования табелей и возврат утверждённого табеля на доработку.

ALTER TABLE timesheet_approvals
  DROP CONSTRAINT IF EXISTS timesheet_approvals_status_check;

ALTER TABLE timesheet_approvals
  ADD CONSTRAINT timesheet_approvals_status_check
  CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'returned'));

CREATE TABLE IF NOT EXISTS timesheet_approval_events (
  id            BIGSERIAL PRIMARY KEY,
  approval_id   BIGINT NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN (
    'submitted',
    'approved',
    'rejected',
    'returned_to_rework'
  )),
  from_status   TEXT,
  to_status     TEXT NOT NULL CHECK (to_status IN (
    'submitted',
    'approved',
    'rejected',
    'returned'
  )),
  actor_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  comment       TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timesheet_approval_events_approval
  ON timesheet_approval_events (approval_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_timesheet_approval_events_period
  ON timesheet_approval_events (department_id, period, created_at DESC);

INSERT INTO timesheet_approval_events (
  approval_id,
  department_id,
  period,
  action,
  from_status,
  to_status,
  actor_user_id,
  comment,
  metadata,
  created_at
)
SELECT
  ta.id,
  ta.department_id,
  ta.period,
  'submitted',
  NULL,
  'submitted',
  ta.submitted_by,
  NULL,
  jsonb_build_object('source', 'backfill'),
  ta.submitted_at
FROM timesheet_approvals ta
WHERE ta.submitted_by IS NOT NULL
  AND ta.submitted_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM timesheet_approval_events tae
    WHERE tae.approval_id = ta.id
      AND tae.action = 'submitted'
  );

INSERT INTO timesheet_approval_events (
  approval_id,
  department_id,
  period,
  action,
  from_status,
  to_status,
  actor_user_id,
  comment,
  metadata,
  created_at
)
SELECT
  ta.id,
  ta.department_id,
  ta.period,
  CASE
    WHEN ta.status = 'approved' THEN 'approved'
    ELSE 'rejected'
  END,
  'submitted',
  CASE
    WHEN ta.status = 'approved' THEN 'approved'
    ELSE 'rejected'
  END,
  ta.reviewed_by,
  ta.review_comment,
  jsonb_build_object('source', 'backfill'),
  ta.reviewed_at
FROM timesheet_approvals ta
WHERE ta.status IN ('approved', 'rejected')
  AND ta.reviewed_by IS NOT NULL
  AND ta.reviewed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM timesheet_approval_events tae
    WHERE tae.approval_id = ta.id
      AND tae.action = CASE
        WHEN ta.status = 'approved' THEN 'approved'
        ELSE 'rejected'
      END
  );
