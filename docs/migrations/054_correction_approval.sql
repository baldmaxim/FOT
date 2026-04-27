-- Миграция: Согласование корректировок табеля админом + чистка устаревших файлов корректировок
-- Дата: 2026-04-27

BEGIN;

-- 1. Новые столбцы согласования корректировок.
ALTER TABLE attendance_adjustments
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'auto_approved'
    CHECK (approval_status IN ('auto_approved', 'pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approval_comment TEXT NULL,
  ADD COLUMN IF NOT EXISTS approved_by UUID NULL REFERENCES user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL;

-- 2. Индекс под выборку pending — основной запрос админской страницы.
CREATE INDEX IF NOT EXISTS idx_attendance_adjustments_pending
  ON attendance_adjustments (work_date)
  WHERE approval_status = 'pending';

-- 3. Чистка вложений к корректировкам: удалить ссылки и сами документы категории attendance_correction.
DELETE FROM document_links
  WHERE entity_type = 'attendance_adjustment';

DELETE FROM documents
  WHERE category = 'attendance_correction';

-- 4. Удалить категорию из справочника, чтобы фронт не мог её использовать.
DELETE FROM document_categories WHERE code = 'attendance_correction';

-- 5. PostgREST schema reload.
NOTIFY pgrst, 'reload schema';

COMMIT;
