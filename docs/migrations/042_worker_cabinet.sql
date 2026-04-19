-- Миграция: Личный кабинет рабочего (variant.object)
-- Дата: 2026-04-18

-- 1. Справочник категорий документов (заменяет CHECK-constraint)
CREATE TABLE IF NOT EXISTS document_categories (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO document_categories (code, label, sort_order) VALUES
  ('certificate', 'Справка',      10),
  ('scan',        'Скан',         20),
  ('approval',    'Согласование', 30),
  ('payslip',     'Расчётный листок', 40),
  ('patent_check','Чек от патента',    50),
  ('other',       'Другое',       99)
ON CONFLICT (code) DO NOTHING;

-- Снимаем старый CHECK-constraint (имя по-умолчанию из миграции 001) и заводим FK
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_category_check;

-- На случай «кривых» значений — прикрепляем только валидные строки
-- (все существующие категории присутствуют в сиде выше)
ALTER TABLE documents
  ADD CONSTRAINT documents_category_fkey
  FOREIGN KEY (category) REFERENCES document_categories(code);

-- 2. Служебные записки
CREATE TABLE IF NOT EXISTS official_memos (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  reviewer_id     UUID REFERENCES user_profiles(id),
  reviewed_at     TIMESTAMPTZ,
  review_comment  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_official_memos_employee_status
  ON official_memos(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_official_memos_status_created
  ON official_memos(status, created_at DESC);

-- 3. Лог напоминаний об истечении патента
CREATE TABLE IF NOT EXISTS patent_expiry_reminder_log (
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reminder_date  DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, reminder_date)
);
