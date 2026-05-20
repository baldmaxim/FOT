-- Миграция 109: МТС «Мобильные сотрудники» — задачи (taskManagement/tasks).
-- Локальное зеркало созданных через нашу систему задач + последние ответы МТС.
-- Контент задачи (title, description, address, status, payload) шифруется
-- AES-256-GCM на бэке. Структурные поля (mts_task_id, subscriber_id, start_date,
-- deadline, created_by, created_at) — plaintext, нужны для сортировки/индексов/scope.

BEGIN;

CREATE TABLE IF NOT EXISTS mts_tasks (
  id              BIGSERIAL PRIMARY KEY,
  mts_task_id     BIGINT UNIQUE,                       -- id из ответа МТС (NULL до подтверждения)
  subscriber_id   BIGINT,                              -- кому назначена (опц.)
  start_date      TIMESTAMPTZ NOT NULL,
  deadline        TIMESTAMPTZ,
  created_by      UUID,                                -- наш user (app_auth.users.id)
  title_enc       TEXT,
  description_enc TEXT,
  address_enc     TEXT,
  status_enc      TEXT,
  payload_enc     TEXT,                                -- полный JSON-ответ МТС (зашифр.)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mts_tasks_subscriber
  ON mts_tasks (subscriber_id, start_date DESC);

CREATE INDEX IF NOT EXISTS idx_mts_tasks_created_by
  ON mts_tasks (created_by, created_at DESC);

COMMIT;
