-- Migration 072: ручное подтверждение/отклонение превышения лимита передвижений
-- Бизнес-логика:
--   actual ≤ limit               -> credited = actual,            status = auto_approved
--   actual >  limit (новый)      -> credited = limit,             status = pending
--   approve превышения вручную   -> credited = actual_minutes,    status = approved
--   reject  превышения вручную   -> credited = norm_minutes,      status = rejected
--
-- Порядок: сначала снимаем старый CHECK, делаем backfill (delayed -> pending), и только
-- потом ставим новый CHECK. Иначе он сразу провалидирует таблицу и упадёт на старых строках 'delayed'.

BEGIN;

ALTER TABLE skud_travel_segments
  DROP CONSTRAINT IF EXISTS skud_travel_segments_status_check;

-- Бэкфилл исторических данных: старые delayed -> pending (руководитель должен решить).
UPDATE skud_travel_segments
   SET status = 'pending'
 WHERE status = 'delayed';

-- Внутри лимита (delay = 0, статус auto_approved) — задним числом проставить credited = actual,
-- чтобы старые записи тоже зачитывались как рабочее время.
UPDATE skud_travel_segments
   SET credited_minutes = actual_minutes
 WHERE status = 'auto_approved'
   AND delay_minutes = 0
   AND credited_minutes = 0;

ALTER TABLE skud_travel_segments
  ADD CONSTRAINT skud_travel_segments_status_check
  CHECK (status IN (
    'auto_approved',
    'pending',
    'approved',
    'rejected',
    'needs_object',
    'needs_route'
  ));

ALTER TABLE skud_travel_segments
  ADD COLUMN IF NOT EXISTS approved_by       UUID REFERENCES user_profiles(id),
  ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_comment  TEXT;

CREATE INDEX IF NOT EXISTS idx_skud_travel_segments_pending
  ON skud_travel_segments (employee_id, work_date)
  WHERE status = 'pending';

COMMIT;
