-- 222: персистентный «Лог синхронизации» МТС Бизнес.
-- mts_business_sync_runs — по строке на каждый прогон (refresh_all / cdr_daily /
--   metrics_daily / catalog_weekly), статус обновляется по завершении;
-- mts_business_sync_log — строки warn/error по конкретным номерам/шагам и
--   события изменений данных абонента (старое→новое ФИО/комментарий, факт
--   смены ПДн-блоба). message/details — БЕЗ ПДн: паспорт/дата рождения сюда
--   не попадают никогда (mts_fio/mts_comment и так хранятся открыто в
--   mts_business_number_map). Номер — enc+hash, как во всех таблицах модуля.
-- pd_data_hash в number_map — SHA-256 канонизированного plaintext-JSON ответа
--   PersonalDataInfo: детект «ПДн изменились» без расшифровки старого блоба
--   (шифротекст AES-GCM не сравним — случайный IV).
--
-- Применять ДО выката бэкенда. Retention (60 дней) — чистка из сервиса-логгера.

CREATE TABLE IF NOT EXISTS mts_business_sync_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job         text NOT NULL,                     -- 'refresh_all'|'cdr_daily'|'metrics_daily'|'catalog_weekly'
  initiator   text NOT NULL DEFAULT 'schedule',  -- 'schedule'|'manual'
  account_id  uuid,                              -- NULL: прогон по всем аккаунтам
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running'
              CHECK (status IN ('running','ok','partial','error','interrupted')),
  summary     text,                              -- человекочитаемый итог одной строкой
  stats       jsonb,                             -- счётчики прогона (numbers/failed/breakdown), без ПДн
  error       text                               -- итоговая ошибка прогона
);

COMMENT ON TABLE mts_business_sync_runs IS
  'Прогоны синхронизаций МТС Бизнес (история для карточки «Лог синхронизации»)';

CREATE INDEX IF NOT EXISTS idx_mts_sync_runs_started
  ON mts_business_sync_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mts_sync_runs_job
  ON mts_business_sync_runs (job, started_at DESC);

CREATE TABLE IF NOT EXISTS mts_business_sync_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid REFERENCES mts_business_sync_runs(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  level       text NOT NULL CHECK (level IN ('info','warn','error')),
  job         text NOT NULL,                     -- денормализовано: фильтр без JOIN
  step        text,                              -- 'subscribers:bill_plan', 'fio_diff', 'pd_changed'…
  account_id  uuid,
  msisdn_hash text,                              -- связка с mts_business_number_map
  msisdn_enc  text,                              -- AES: показать номер в UI (расшифровка на сервере)
  error_code  text,                              -- '401/1014', '500/9999'…
  bucket      text,                              -- класс ошибки (mtsErrorBucket)
  message     text NOT NULL,                     -- текст без ПДн
  details     jsonb                              -- {"fio":{"old":"…","new":"…"}}; БЕЗ паспорта/ДР
);

COMMENT ON TABLE mts_business_sync_log IS
  'Записи лога синхронизаций МТС Бизнес: warn/error по номерам/шагам + diff-события данных абонента';
COMMENT ON COLUMN mts_business_sync_log.run_id IS
  'NULL — событие вне прогона (rolling-конвейер пишет только ошибки)';

CREATE INDEX IF NOT EXISTS idx_mts_sync_log_run ON mts_business_sync_log (run_id, id);
CREATE INDEX IF NOT EXISTS idx_mts_sync_log_at  ON mts_business_sync_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_mts_sync_log_warn
  ON mts_business_sync_log (at DESC) WHERE level <> 'info';

-- Детект изменения ПДн-блоба без хранения/сравнения открытых данных.
ALTER TABLE mts_business_number_map
  ADD COLUMN IF NOT EXISTS pd_data_hash text;
COMMENT ON COLUMN mts_business_number_map.pd_data_hash IS
  'SHA-256 канонизированного plaintext PersonalDataInfo — только для детекта изменений; сами данные — в pd_data_enc';
