-- 224_adaptive_testing.sql
-- Адаптивное тестирование в ЛК: 10 вопросов от LLM (openai/gpt-5.6-luna через
-- OpenRouter-прокси) по skill-профилю «отдел + должность».
--
-- 1. adaptive_skill_profiles — обязанности/компетенции отдела (+опц. должности).
--    ON DELETE CASCADE по отделу/должности: clearStructure делает полный
--    DELETE FROM org_departments — RESTRICT сломал бы реимпорт структуры.
-- 2. adaptive_test_sessions / questions / answers — сессия из 10 вопросов,
--    автомат генерации pending→generating→ready|failed, оценка
--    pending→evaluating→evaluated|failed, lease + token для CAS.
-- 3. adaptive_llm_calls — ledger стоимости всех LLM-вызовов (включая
--    отброшенные по устаревшему токену).
-- 4. Права: /employee/testing (все сотрудние роли; пилот закрыт email-allowlist)
--    и /testing-review (руководящие роли view, admin edit).
-- 5. system_settings — фича ВЫКЛЮЧЕНА по умолчанию; allowlist = только Есенов.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Требует уже применённой 221 (access_pages.area).

BEGIN;

-- ============================ Skill-профили ============================

CREATE TABLE IF NOT EXISTS adaptive_skill_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_department_id UUID NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  position_id       UUID REFERENCES positions(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  duties_text       TEXT NOT NULL,
  competencies      JSONB NOT NULL DEFAULT '[]',
  is_published      BOOLEAN NOT NULL DEFAULT false,
  created_by        UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- position_id NULL = профиль всего отдела; уникальность скоупа — только
-- expression-индексом (табличный UNIQUE с COALESCE невозможен).
CREATE UNIQUE INDEX IF NOT EXISTS uq_adaptive_skill_profiles_scope
  ON adaptive_skill_profiles (
    org_department_id,
    COALESCE(position_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_adaptive_skill_profiles_published
  ON adaptive_skill_profiles (org_department_id) WHERE is_published = true;

-- ============================ Сессии ============================

CREATE TABLE IF NOT EXISTS adaptive_test_sessions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE осознанно: физическое удаление сотрудника (полный реимпорт
  -- структуры) удаляет и историю тестов — конвенция test_responses.
  employee_id                 INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  user_id                     UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  skill_profile_id            UUID REFERENCES adaptive_skill_profiles(id) ON DELETE SET NULL,
  profile_snapshot            JSONB NOT NULL,
  department_id_snapshot      UUID,
  position_id_snapshot        UUID,
  model                       TEXT NOT NULL,
  prompt_version              TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'in_progress'
                                CHECK (status IN ('in_progress', 'completed', 'cancelled', 'error')),
  -- Автомат генерации: pending (нужен вопрос) → generating → ready (вопрос
  -- показан, ждём ответ) | failed. 'idle' не используется — смешивал
  -- «вопрос готов» и «нужен следующий».
  generation_state            TEXT NOT NULL DEFAULT 'pending'
                                CHECK (generation_state IN ('pending', 'generating', 'ready', 'failed')),
  generation_token            UUID,
  generation_started_at       TIMESTAMPTZ,
  generation_lease_expires_at TIMESTAMPTZ,
  -- Счётчик попыток ТЕКУЩЕГО вопроса: сбрасывается в 0 при переходе в ready.
  generation_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (generation_attempts >= 0),
  generation_last_error       TEXT,
  manual_retry_count          INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry_count >= 0),
  total_questions             INTEGER NOT NULL DEFAULT 10 CHECK (total_questions = 10),
  current_seq                 INTEGER NOT NULL DEFAULT 0
                                CHECK (current_seq >= 0 AND current_seq <= total_questions),
  competency_state            JSONB NOT NULL DEFAULT '{}',
  overall_score               INTEGER CHECK (overall_score BETWEEN 0 AND 100),
  coverage_pct                INTEGER CHECK (coverage_pct BETWEEN 0 AND 100),
  strengths                   JSONB,
  weaknesses                  JSONB,
  recommendations             JSONB,
  prompt_tokens               INTEGER NOT NULL DEFAULT 0,
  completion_tokens           INTEGER NOT NULL DEFAULT 0,
  cost_usd                    NUMERIC NOT NULL DEFAULT 0,
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ NOT NULL
);

-- Одна активная сессия на сотрудника.
CREATE UNIQUE INDEX IF NOT EXISTS uq_adaptive_sessions_active
  ON adaptive_test_sessions (employee_id) WHERE status = 'in_progress';

-- Дневной лимит сессий (сутки Europe/Moscow считаются в приложении).
CREATE INDEX IF NOT EXISTS idx_adaptive_sessions_employee_started
  ON adaptive_test_sessions (employee_id, started_at DESC);

-- Sweeper: генерация, требующая работы или с истёкшим lease.
CREATE INDEX IF NOT EXISTS idx_adaptive_sessions_generation_sweep
  ON adaptive_test_sessions (generation_lease_expires_at)
  WHERE status = 'in_progress' AND generation_state IN ('pending', 'generating');

-- Sweeper: финализация просроченных сессий.
CREATE INDEX IF NOT EXISTS idx_adaptive_sessions_status_expires
  ON adaptive_test_sessions (status, expires_at);

-- ============================ Вопросы ============================

CREATE TABLE IF NOT EXISTS adaptive_test_questions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL REFERENCES adaptive_test_sessions(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL CHECK (seq >= 1 AND seq <= 10),
  competency_key     TEXT NOT NULL,
  difficulty         INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
  type               TEXT NOT NULL CHECK (type IN ('single', 'multiple', 'text')),
  question_text      TEXT NOT NULL,
  options            JSONB,
  correct_option_ids JSONB,
  rubric             JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, seq)
);

-- ============================ Ответы ============================

-- session_id намеренно отсутствует: сессия — через JOIN к questions,
-- рассогласование question↔session невозможно.
CREATE TABLE IF NOT EXISTS adaptive_test_answers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id           UUID NOT NULL UNIQUE REFERENCES adaptive_test_questions(id) ON DELETE CASCADE,
  answer                JSONB NOT NULL,
  eval_state            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (eval_state IN ('pending', 'evaluating', 'evaluated', 'failed')),
  eval_token            UUID,
  eval_started_at       TIMESTAMPTZ,
  eval_lease_expires_at TIMESTAMPTZ,
  eval_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (eval_attempts >= 0),
  eval_last_error       TEXT,
  score                 INTEGER CHECK (score BETWEEN 0 AND 100),
  eval                  JSONB,
  answered_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at          TIMESTAMPTZ
);

-- Sweeper: оценки, требующие работы или с истёкшим lease.
CREATE INDEX IF NOT EXISTS idx_adaptive_answers_eval_sweep
  ON adaptive_test_answers (eval_lease_expires_at)
  WHERE eval_state IN ('pending', 'evaluating');

-- ============================ Ledger LLM-вызовов ============================

-- Стоимость учитывается независимо от token-guarded финализации: вызов,
-- отброшенный по устаревшему токену/отменённой сессии, всё равно был оплачен.
CREATE TABLE IF NOT EXISTS adaptive_llm_calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID REFERENCES adaptive_test_sessions(id) ON DELETE SET NULL,
  purpose           TEXT NOT NULL CHECK (purpose IN ('generate', 'evaluate', 'health_check')),
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          NUMERIC NOT NULL DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN ('ok', 'invalid_json', 'http_error', 'discarded')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adaptive_llm_calls_session
  ON adaptive_llm_calls (session_id, created_at);

-- ============================ Доступ ============================

INSERT INTO access_pages (
  key, label, group_code, group_label, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system, area
)
VALUES
  ('/employee/testing', 'Тестирование', 'lk', 'Личный кабинет', 'page',
    true, false, false, 19, true, true, 'personal'),
  ('/testing-review', 'Тестирование (разбор)', 'work', 'Управление', 'page',
    true, true, false, 132, true, true, 'admin')
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label,
    group_code = EXCLUDED.group_code,
    group_label = EXCLUDED.group_label,
    surface = EXCLUDED.surface,
    supports_edit = EXCLUDED.supports_edit,
    requires_data_scope = EXCLUDED.requires_data_scope,
    sort_order = EXCLUDED.sort_order,
    is_active = true,
    is_system = EXCLUDED.is_system,
    area = EXCLUDED.area,
    updated_at = NOW();

-- Прохождение теста: все сотрудние варианты ЛК (office + object).
-- Пилот закрыт серверным email-allowlist (system_settings), права — заранее,
-- чтобы массовый запуск включался одной настройкой без новой миграции.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT code, '/employee/testing', true, true
  FROM system_roles
 WHERE employee_variant IN ('office', 'object')
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

-- Разбор результатов: руководящие роли — view, админ — view+edit.
-- hr намеренно не сидируется (исходная матрица: сотрудник/руководитель/админ).
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT code, '/testing-review', true, (code = 'admin')
  FROM system_roles
 WHERE code IN ('manager', 'manager_obj', 'site_supervisor', 'admin')
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

-- ============================ Настройки ============================

-- DO NOTHING: повторное применение миграции не сбросит allowlist
-- и не включит/выключит фичу.
INSERT INTO system_settings (key, value, description, is_secret)
VALUES
  ('adaptive_testing_enabled', 'false',
   'Адаптивное тестирование: включено (kill switch)', false),
  ('adaptive_testing_allowed_emails', 'esenov.m.n@su10.ru',
   'Адаптивное тестирование: email-allowlist (CSV; пусто = никому; * = всем с правом)', false),
  ('adaptive_testing_model', 'openai/gpt-5.6-luna',
   'Адаптивное тестирование: модель OpenRouter', false),
  ('adaptive_testing_daily_sessions_limit', '1',
   'Адаптивное тестирование: сессий на сотрудника в сутки (МСК)', false),
  ('adaptive_testing_connection_mode', 'shared_proxy',
   'Адаптивное тестирование: shared_proxy | dedicated_proxy', false),
  ('adaptive_testing_zdr_required', 'false',
   'Адаптивное тестирование: требовать ZDR-роутинг OpenRouter', false)
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
