-- 375: статусы выгрузки «сотрудников месяца» в ЗУП3 по половинам месяца (1–15 и 16–конец).
--
-- 1С забирает и подтверждает каждую половину отдельно (GET /staff-month?half=1|2, POST /staff-month/ack с half):
-- подтверждение 1–15 не закрывает 16–конец. Устроено как статусы месяца (373), но ключ — «сотрудник + месяц +
-- половина». Таблицы 373 не трогаются: бэкенд до перезапуска пишет в них как раньше, новый их не читает (удаление —
-- отдельной миграцией). Повтор безопасен в любой момент: только CREATE … IF NOT EXISTS. Откат —
-- docs/rollbacks/375_staff_month_1c_halves_rollback.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_month_1c_half_revisions (
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month          DATE NOT NULL,
  half           SMALLINT NOT NULL CHECK (half IN (1, 2)),
  state_revision BIGINT NOT NULL CHECK (state_revision > 0),
  present        BOOLEAN NOT NULL,
  preliminary    BOOLEAN NOT NULL,
  content_hash   TEXT,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, month, half, state_revision),
  CONSTRAINT staff_month_1c_half_revision_month_first_day CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT staff_month_1c_half_revision_hash CHECK (
    (present AND content_hash ~ '^[0-9a-f]{64}$') OR (NOT present AND content_hash IS NULL AND NOT preliminary))
);

CREATE TABLE IF NOT EXISTS staff_month_1c_half_states (
  employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month            DATE NOT NULL,
  half             SMALLINT NOT NULL CHECK (half IN (1, 2)),
  current_revision BIGINT NOT NULL,
  PRIMARY KEY (employee_id, month, half),
  FOREIGN KEY (employee_id, month, half, current_revision)
    REFERENCES staff_month_1c_half_revisions (employee_id, month, half, state_revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS staff_month_1c_half_states_month_idx ON staff_month_1c_half_states (month, half);

CREATE TABLE IF NOT EXISTS staff_month_1c_half_exports (
  employee_id     INTEGER NOT NULL,
  month           DATE NOT NULL,
  half            SMALLINT NOT NULL CHECK (half IN (1, 2)),
  state_revision  BIGINT NOT NULL,
  content_hash    TEXT,
  document_ref    TEXT CHECK (document_ref IS NULL OR (btrim(document_ref) <> '' AND length(document_ref) <= 200)),
  data_api_key_id UUID REFERENCES data_api_keys(id) ON DELETE SET NULL,
  acked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, month, half, state_revision),
  FOREIGN KEY (employee_id, month, half, state_revision)
    REFERENCES staff_month_1c_half_revisions (employee_id, month, half, state_revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS staff_month_1c_half_exports_month_idx ON staff_month_1c_half_exports (month, half);

-- Последняя сборка месяца (обе половины пишутся одной сборкой): отпечаток закрытой части и время — фоновое
-- обновление не пересобирает месяц после рестарта. started_at — фоновая сборка начата и не завершилась: следующая
-- попытка не раньше чем через час.
CREATE TABLE IF NOT EXISTS staff_month_1c_half_builds (
  month       DATE PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
  fingerprint TEXT,
  built_at    TIMESTAMPTZ,
  started_at  TIMESTAMPTZ
);

COMMENT ON TABLE staff_month_1c_half_revisions IS
  'API для ЗУП3: ревизии состояния «сотрудник + месяц + половина» (present/preliminary/content_hash строки staff-month?half). Только добавление.';
COMMENT ON TABLE staff_month_1c_half_states IS 'API для ЗУП3: текущая ревизия «сотрудник + месяц + половина».';
COMMENT ON TABLE staff_month_1c_half_exports IS 'API для ЗУП3: подтверждения 1С (ACK) ревизий строк половины месяца.';
COMMENT ON TABLE staff_month_1c_half_builds IS 'API для ЗУП3: последняя сборка месяца для статусов по половинам.';

COMMIT;
