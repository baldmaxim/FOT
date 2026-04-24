-- Миграция: Вложения к подаче табеля и аудит авторства корректировок
-- Дата: 2026-04-24

-- 1. Аудит апдейтов корректировок: кто последний менял (created_by остаётся автором записи)
ALTER TABLE attendance_adjustments
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_adjustments_created_by
  ON attendance_adjustments (created_by) WHERE created_by IS NOT NULL;

-- 2. Документы для вложений к подаче табеля не привязаны к конкретному сотруднику
ALTER TABLE documents ALTER COLUMN employee_id DROP NOT NULL;

-- 3. Категория документа для подтверждения работы в выходные
INSERT INTO document_categories (code, label, sort_order) VALUES
  ('timesheet_weekend_confirmation', 'Подтверждение работы в выходные', 60)
ON CONFLICT (code) DO NOTHING;

-- 4. Индекс под выборку вложений по подаче табеля
CREATE INDEX IF NOT EXISTS idx_document_links_timesheet_approval
  ON document_links (entity_id, purpose)
  WHERE entity_type = 'timesheet_approval';
