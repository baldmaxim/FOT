-- Миграция 197: МТС «Бизнес» (Business API) — детализация звонков (CDR, время
-- разговоров). Отдельный модуль, собственные таблицы mts_business_*, без FK в
-- skud_*/mts_* (M-Poisk). Применяется вручную через psql (авто-миграций нет).
--
-- Несколько API — по одному на лицевой счёт: креды хранятся в таблице
-- mts_business_accounts (пароль зашифрован). ПДн (номера телефонов, состав
-- заявки) шифруются на бэке (encryption.service, AES-256-GCM) и лежат ciphertext
-- в колонках *_enc. Хэши/даты/длительность — структурные поля (дедуп/джойн/
-- агрегация), не контент. id аккаунта генерируется на бэке (crypto.randomUUID()).

BEGIN;

-- 0. Аккаунты (несколько API/лицевых счетов). Пароль — ciphertext (AES-256-GCM).
CREATE TABLE IF NOT EXISTS mts_business_accounts (
  id             UUID PRIMARY KEY,
  label          TEXT NOT NULL,
  account_number TEXT,                        -- лицевой счёт (ЛС)
  login          TEXT NOT NULL,
  password_enc   TEXT NOT NULL,               -- зашифрован
  base_url       TEXT,                        -- по умолчанию api.mts.ru/b2b/v1
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. Заявки на детализацию. Документ уходит на email; здесь трекаем статус по
--    messageId (Completed/InProgress/Faulted → in_progress/completed/faulted/unknown).
CREATE TABLE IF NOT EXISTS mts_business_detalization_requests (
  message_id    TEXT PRIMARY KEY,
  account_id    UUID REFERENCES mts_business_accounts(id) ON DELETE SET NULL,
  scope         VARCHAR(16) NOT NULL,       -- 'msisdn' | 'account'
  target_enc    TEXT,                        -- зашифрованный JSON списка номеров/счетов
  date_from     DATE NOT NULL,
  date_to       DATE NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'in_progress',
  requested_by  UUID,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mts_business_requests_status
  ON mts_business_detalization_requests (status, requested_at DESC);

-- 2. Строки детализации (звонки). Дедуп по dedup_hash. msisdn_hash — для джойна с
--    привязкой номеров и агрегации (детерминированный SHA-256 канонического номера).
CREATE TABLE IF NOT EXISTS mts_business_cdr (
  id                BIGSERIAL PRIMARY KEY,
  dedup_hash        TEXT NOT NULL UNIQUE,
  msisdn_hash       TEXT,                    -- хэш собственного номера (не ПДн)
  msisdn_enc        TEXT,                    -- зашифрованный собственный номер
  peer_number_enc   TEXT,                    -- зашифрованный номер собеседника
  direction         VARCHAR(40),             -- направление/тип (не ПДн)
  started_at        TIMESTAMPTZ NOT NULL,
  duration_sec      INTEGER NOT NULL DEFAULT 0,
  call_type         VARCHAR(40),
  source_message_id TEXT,                    -- из какой заявки загружено (если известно)
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mts_business_cdr_msisdn_time
  ON mts_business_cdr (msisdn_hash, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mts_business_cdr_started
  ON mts_business_cdr (started_at DESC);

-- 3. Привязка номера (MSISDN) → сотрудник FOT. Ключ — хэш номера; сам номер
--    хранится зашифрованным.
CREATE TABLE IF NOT EXISTS mts_business_number_map (
  msisdn_hash  TEXT PRIMARY KEY,
  msisdn_enc   TEXT,
  employee_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  linked_by    UUID,
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mts_business_number_map_employee
  ON mts_business_number_map (employee_id);

-- 4. Страница доступа (блок «Администрирование»), рядом с /mts.
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES
  ('/mts-business', 'МТС Бизнес — звонки', 'admin', 'Администрирование', 'page', true, 246, true)
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label,
    group_code = EXCLUDED.group_code,
    group_label = EXCLUDED.group_label,
    surface = EXCLUDED.surface,
    supports_edit = EXCLUDED.supports_edit,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- 5. Доступ — только super_admin (как у /mts, миграция 108).
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('super_admin', '/mts-business', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
