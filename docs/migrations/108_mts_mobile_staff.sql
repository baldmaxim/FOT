-- Миграция 108: МТС «Мобильные сотрудники» (M-Poisk) — отдельный модуль геолокации.
-- Изолирован от СКУД/табеля: собственные таблицы mts_*, без FK в skud_*.
-- Привязка абонента МТС к сотруднику FOT — через mts_subscriber_map.employee_id
-- (employees уже несёт sigur_employee_id, идентичность «из сигур» резолвится транзитивно).
-- Применяется вручную через psql (авто-миграций в проекте нет).

BEGIN;

-- 1. Маппинг абонент МТС -> сотрудник FOT. Одна строка на subscriber_id.
-- ПДн (phone, display_name) шифруются на бэке (encryption.service, AES-256-GCM)
-- и хранятся как ciphertext в формате iv:authTag:encrypted.
CREATE TABLE IF NOT EXISTS mts_subscriber_map (
  subscriber_id  BIGINT PRIMARY KEY,
  employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  phone_enc      TEXT,
  display_name_enc TEXT,
  linked_by      UUID,
  linked_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mts_subscriber_map_employee
  ON mts_subscriber_map (employee_id);

-- 2. Снимки текущих позиций абонентов (history-трек запрашивается у МТС по требованию,
--    поток целиком не храним). Дедуп по (subscriber_id, recorded_at).
-- Контент от МТС (координаты, адрес, точность, state/source) НЕ хранится в открытом
-- виде — шифруется на бэке (encryption.service, AES-256-GCM), колонки *_enc — ciphertext.
-- subscriber_id и recorded_at/synced_at — структурные ключи (дедуп/индекс/ретеншн), не контент.
CREATE TABLE IF NOT EXISTS mts_location_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  subscriber_id  BIGINT NOT NULL,
  lat_enc        TEXT,
  lon_enc        TEXT,
  accuracy_m_enc TEXT,
  address_enc    TEXT,
  state_enc      TEXT,
  source_enc     TEXT,
  recorded_at    TIMESTAMPTZ NOT NULL,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscriber_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_mts_location_snapshots_subscriber
  ON mts_location_snapshots (subscriber_id, recorded_at DESC);

-- 3. Регистрируем страницу в каталоге доступа (блок «Администрирование»).
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES
  ('/mts', 'Мобильные сотрудники МТС', 'admin', 'Администрирование', 'page', true, 245, true)
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label,
    group_code = EXCLUDED.group_code,
    group_label = EXCLUDED.group_label,
    surface = EXCLUDED.surface,
    supports_edit = EXCLUDED.supports_edit,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- 4. Доступ — только super_admin (как у /skud-settings, миграция 017).
--    Компанийный admin получает доступ через user_company_access/роли отдельно при необходимости.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('super_admin', '/mts', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
