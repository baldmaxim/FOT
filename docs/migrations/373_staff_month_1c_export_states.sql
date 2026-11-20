-- 373: статусы выгрузки «сотрудников месяца» в ЗУП3 (GET /api/public/v1/staff-month).
--
-- Состояние пары «сотрудник + месяц» — present / preliminary / content_hash строки API. Меняется — новая ревизия
-- (монотонная по паре), сотрудник пропал из месяца — ревизия-надгробие (present = false). 1С подтверждает ревизию
-- (POST /staff-month/ack); статус «Готов к выгрузке» / «Выгружен» / «Изменён после выгрузки» — текущая ревизия
-- против последней подтверждённой. Ревизии хранятся долговременно: подтверждение не зависит от снимка в памяти.
-- Повтор миграции безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_month_1c_state_revisions (
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month          DATE NOT NULL,
  state_revision BIGINT NOT NULL CHECK (state_revision > 0),
  present        BOOLEAN NOT NULL,
  preliminary    BOOLEAN NOT NULL,
  content_hash   TEXT,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, month, state_revision),
  CONSTRAINT staff_month_1c_revision_month_first_day CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT staff_month_1c_revision_hash CHECK (
    (present AND content_hash ~ '^[0-9a-f]{64}$') OR (NOT present AND content_hash IS NULL AND NOT preliminary))
);

CREATE TABLE IF NOT EXISTS staff_month_1c_states (
  employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month            DATE NOT NULL,
  current_revision BIGINT NOT NULL,
  PRIMARY KEY (employee_id, month),
  FOREIGN KEY (employee_id, month, current_revision)
    REFERENCES staff_month_1c_state_revisions (employee_id, month, state_revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS staff_month_1c_states_month_idx ON staff_month_1c_states (month);

CREATE TABLE IF NOT EXISTS staff_month_1c_exports (
  employee_id     INTEGER NOT NULL,
  month           DATE NOT NULL,
  state_revision  BIGINT NOT NULL,
  content_hash    TEXT,
  document_ref    TEXT CHECK (document_ref IS NULL OR (btrim(document_ref) <> '' AND length(document_ref) <= 200)),
  data_api_key_id UUID REFERENCES data_api_keys(id) ON DELETE SET NULL,
  acked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, month, state_revision),
  FOREIGN KEY (employee_id, month, state_revision)
    REFERENCES staff_month_1c_state_revisions (employee_id, month, state_revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS staff_month_1c_exports_month_idx ON staff_month_1c_exports (month);

-- Последняя сборка месяца: отпечаток закрытой части и время — фоновое обновление не пересобирает месяц после рестарта,
-- если табели не менялись и ночная сборка уже была. started_at — фоновая сборка начата: не завершилась (сбой, рестарт
-- по памяти) — следующая попытка не раньше чем через час, без цикла «рестарт → сборка».
CREATE TABLE IF NOT EXISTS staff_month_1c_builds (
  month       DATE PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
  fingerprint TEXT,
  built_at    TIMESTAMPTZ,
  started_at  TIMESTAMPTZ
);

COMMENT ON TABLE staff_month_1c_state_revisions IS
  'API для ЗУП3: ревизии состояния «сотрудник + месяц» (present/preliminary/content_hash строки staff-month). Только добавление.';
COMMENT ON TABLE staff_month_1c_states IS 'API для ЗУП3: текущая ревизия пары «сотрудник + месяц».';
COMMENT ON TABLE staff_month_1c_exports IS 'API для ЗУП3: подтверждения 1С (ACK) ревизий строк staff-month.';

COMMIT;
