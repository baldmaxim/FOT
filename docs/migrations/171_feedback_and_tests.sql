-- Миграция: Обратная связь (предложения/жалобы) + система тестирования (опросники)
-- Дата: 2026-06-07
--
-- 1) feedback_messages — предложения и жалобы из ЛК. Автор хранится всегда,
--    но при is_anonymous=true не выводится администратору.
-- 2) Опросники: tests / test_questions / test_options / test_assignments
--    (назначение на отдел) / test_responses / test_answers.
-- Тесты без оценки (нет правильных ответов) — сбор данных.

BEGIN;

-- ============================ Обратная связь ============================

CREATE TABLE IF NOT EXISTS feedback_messages (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('suggestion', 'complaint')),
  content       TEXT NOT NULL,
  is_anonymous  BOOLEAN NOT NULL DEFAULT false,
  department_id UUID REFERENCES org_departments(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_kind_created
  ON feedback_messages (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_department
  ON feedback_messages (department_id);

-- ============================ Тесты (опросники) ============================

CREATE TABLE IF NOT EXISTS tests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title              TEXT NOT NULL,
  description        TEXT,
  active_from        TIMESTAMPTZ,
  active_to          TIMESTAMPTZ,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID,
  company_root_id    UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tests_active ON tests (is_active);
CREATE INDEX IF NOT EXISTS idx_tests_company_root ON tests (company_root_id);

CREATE TABLE IF NOT EXISTS test_questions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id      UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  text         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('single', 'multiple', 'text')),
  allow_custom BOOLEAN NOT NULL DEFAULT false,
  is_required  BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_test_questions_test
  ON test_questions (test_id, position);

CREATE TABLE IF NOT EXISTS test_options (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES test_questions(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_test_options_question
  ON test_options (question_id, position);

CREATE TABLE IF NOT EXISTS test_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (test_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_test_assignments_dept
  ON test_assignments (department_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS test_responses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  department_id UUID REFERENCES org_departments(id) ON DELETE SET NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (test_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_test_responses_test
  ON test_responses (test_id, status);

CREATE TABLE IF NOT EXISTS test_answers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id        UUID NOT NULL REFERENCES test_responses(id) ON DELETE CASCADE,
  question_id        UUID NOT NULL REFERENCES test_questions(id) ON DELETE CASCADE,
  selected_option_ids UUID[] NOT NULL DEFAULT '{}',
  custom_text        TEXT,
  UNIQUE (response_id, question_id)
);

-- ============================ Доступ ============================

INSERT INTO access_pages (
  key, label, group_code, group_label, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system
)
VALUES
  ('/employee/feedback', 'Обратная связь', 'employee', 'Личный кабинет', 'page',
    true, false, false, 76, true, true),
  ('/feedback-review', 'Обратная связь', 'operations', 'Управление', 'page',
    true, true, false, 131, true, true)
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label,
    group_code = EXCLUDED.group_code,
    group_label = EXCLUDED.group_label,
    surface = EXCLUDED.surface,
    supports_edit = EXCLUDED.supports_edit,
    requires_data_scope = EXCLUDED.requires_data_scope,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active,
    is_system = EXCLUDED.is_system,
    updated_at = NOW();

-- Отправка ОС/прохождение тестов — офисные роли (как /employee/tasks).
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('office',  '/employee/feedback', true, true),
  ('manager', '/employee/feedback', true, true),
  ('admin',   '/employee/feedback', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

-- Просмотр/управление — только администраторы (роль admin: системные = без
-- записей в user_company_access, компанийные = со скоупом). Роль super_admin
-- удалена миграцией 044 (переименована в admin), поэтому здесь не сидируется.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('admin', '/feedback-review', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
