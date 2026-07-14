-- 217_mts_business_statement_rows_and_employee_sim.sql
-- МТС Бизнес в ЛК сотрудника: «Моя SIM» + «Телефонная книга».
--
-- 1) Таблица полных строк выписки (звонки/СМС/интернет/прочее) —
--    ночной прогон «Обновить всё» уже получает выписку целиком
--    (Bills/BillingStatementExtdByMSISDN), но сохранял только звонки в
--    mts_business_cdr. Теперь ВСЕ строки пишутся сюда, и оба потребителя
--    (ЛК сотрудника и админская вкладка «Использование») читают из БД,
--    не дергая МТС живьём.
-- 2) Страницы ЛК /employee/sim и /employee/phonebook в каталоге доступа +
--    view-права офисным ролям (как /employee/tasks в 062 и
--    /employee/feedback в 171). Объектному worker не выдаём.
--
-- ПРИМЕНЯТЬ ДО деплоя бэкенда.

BEGIN;

-- 1. Полные строки выписки. ПДн (номер собеседника) — шифром peer_enc;
--    числа/даты/категории plain — по ним SQL-агрегация дневной статистики.
CREATE TABLE IF NOT EXISTS mts_business_statement_rows (
  id            BIGSERIAL PRIMARY KEY,
  dedup_hash    TEXT NOT NULL UNIQUE,
  account_id    UUID REFERENCES mts_business_accounts(id) ON DELETE SET NULL,
  msisdn_hash   TEXT NOT NULL,              -- SHA-256 канонического 7XXXXXXXXXX (не ПДн)
  usage_date    DATE NOT NULL,              -- дата события — агрегаты по дням
  event_at      TIMESTAMPTZ,                -- полный момент события (если распознан)
  category      VARCHAR(16) NOT NULL,       -- calls|sms|internet|periodic|oneTime|topups|other
  network_event VARCHAR(40),
  direction     VARCHAR(3),                 -- in|out|NULL
  label         TEXT,                       -- человекочитаемое описание МТС
  peer_hash     TEXT,                       -- хэш собеседника (только если это телефон)
  peer_enc      TEXT,                       -- 🔒 собеседник/APN (AES-256-GCM, iv:authTag:enc)
  units         NUMERIC,                    -- factUnits (секунды/байты/шт)
  unit_code     VARCHAR(16),                -- SECOND|BYTE|ITEM|...
  amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
  source        VARCHAR(16) NOT NULL DEFAULT 'nightly',  -- nightly|manual|backfill
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mts_biz_stmt_msisdn_date
  ON mts_business_statement_rows (msisdn_hash, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_mts_biz_stmt_account_date
  ON mts_business_statement_rows (account_id, usage_date DESC);

-- 2. Страницы ЛК в каталоге доступа (блок «Моё», view-only).
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES
  ('/employee/sim',       'Личный кабинет — Моя SIM',          'mine', 'Моё', 'page', false, 15, true),
  ('/employee/phonebook', 'Личный кабинет — Телефонная книга', 'mine', 'Моё', 'page', false, 16, true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- 3. Права офисным ролям (OR-семантика — не отбираем уже выданное шире).
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('office',  '/employee/sim',       true, false),
  ('manager', '/employee/sim',       true, false),
  ('admin',   '/employee/sim',       true, false),
  ('office',  '/employee/phonebook', true, false),
  ('manager', '/employee/phonebook', true, false),
  ('admin',   '/employee/phonebook', true, false)
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
