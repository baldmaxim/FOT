-- Миграция 060: публичный read-only Data API.
-- Таблицы для управления API-ключами, whitelist (таблица + список полей)
-- и логом запросов. Сами данные читает FastAPI-сервис fot-data-api,
-- а UI управления живёт в Express + админ-вкладке /admin/data-api.
-- Дата: 2026-04-28

BEGIN;

CREATE TABLE IF NOT EXISTS data_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  -- Первые 8 символов секрета — публичный идентификатор для быстрого lookup.
  key_prefix TEXT NOT NULL UNIQUE,
  -- bcrypt-хеш полного секрета (plaintext возвращается клиенту ровно один раз).
  key_hash TEXT NOT NULL,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute > 0),
  created_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_data_api_keys_active
  ON data_api_keys (revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS data_api_key_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id UUID NOT NULL REFERENCES data_api_keys(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  allowed_fields TEXT[] NOT NULL CHECK (array_length(allowed_fields, 1) >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (key_id, table_name)
);

CREATE INDEX IF NOT EXISTS idx_data_api_key_tables_key
  ON data_api_key_tables (key_id);

CREATE TABLE IF NOT EXISTS data_api_request_logs (
  id BIGSERIAL PRIMARY KEY,
  key_id UUID REFERENCES data_api_keys(id) ON DELETE SET NULL,
  table_name TEXT,
  ip TEXT,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER,
  query_params JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_api_logs_key_time
  ON data_api_request_logs (key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_api_logs_time
  ON data_api_request_logs (created_at DESC);

-- Регистрируем страницу в каталоге доступов.
INSERT INTO access_pages (
  key, label, group_code, group_label, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system
)
VALUES
  ('/admin/data-api', 'API-доступ к данным', 'admin', 'Администрирование',
   'page', true, false, false, 290, true, true)
ON CONFLICT (key) DO UPDATE
SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  requires_data_scope = EXCLUDED.requires_data_scope,
  requires_employee_variant = EXCLUDED.requires_employee_variant,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  is_system = EXCLUDED.is_system,
  updated_at = NOW();

-- По умолчанию доступ к новой странице получают только super_admin (is_admin = true).
-- Остальные роли явно не получают доступ — добавлять при необходимости через UI.

-- Возвращает список таблиц схемы public с их колонками. Используется UI
-- управления Data API, чтобы показать чек-лист «таблица → поля». Доступ
-- (deny-list по чувствительным полям и системным таблицам) применяется
-- на стороне Express, а сама функция отдаёт «сырой» каталог.
CREATE OR REPLACE FUNCTION data_api_list_public_schema()
RETURNS TABLE (
  table_name TEXT,
  column_name TEXT,
  data_type TEXT,
  is_nullable BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    c.table_name::text,
    c.column_name::text,
    c.data_type::text,
    (c.is_nullable = 'YES')::boolean AS is_nullable
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
  WHERE c.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
  ORDER BY c.table_name, c.ordinal_position;
$$;

REVOKE ALL ON FUNCTION data_api_list_public_schema() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_api_list_public_schema() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
