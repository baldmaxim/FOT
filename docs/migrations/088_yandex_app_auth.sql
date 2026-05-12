-- 088_yandex_app_auth.sql
--
-- Локальная auth-схема, замещающая Supabase Auth (схему `auth`) при переезде
-- на Yandex Managed PostgreSQL.
--
-- Используем отдельную схему `app_auth`, чтобы не конфликтовать с Supabase
-- naming (auth.users / auth.identities / auth.sessions). Это позволяет
-- параллельно работать со старой схемой `auth` до момента отключения
-- Supabase Auth в проде.
--
-- См. docs/yandex-postgres-migration/00_inventory_v2.md §4 — все 15 вызовов
-- supabase.auth.admin.* / supabaseAuth.auth.signInWithPassword мигрированы
-- на fot-server/src/services/local-auth.service.ts (bcryptjs hash/compare).
--
-- ─── Scope этой миграции ───────────────────────────────────────────────────
-- Эта миграция отвечает ТОЛЬКО за схему app_auth и таблицу users (плюс
-- индексы, триггер updated_at, comments).
--
-- Cross-schema FK public.user_profiles(id) → app_auth.users(id) В ЭТОЙ
-- МИГРАЦИИ НЕ СОЗДАЁТСЯ. Жизненный цикл FK (drop legacy, create NOT VALID,
-- VALIDATE) полностью выполняет
-- fot-server/scripts/yandex-migration/validate-auth-fk.ts, который
-- запускается ПОСЛЕ restore public data + backfill app_auth.users.
--
-- Причины разделения:
-- 1) 088 не зависит от наличия public.user_profiles — её можно применять
--    в любом порядке относительно pre-data schema;
-- 2) FK имеет смысл только когда обе таблицы наполнены — иначе VALIDATE
--    падает на orphans. validate-auth-fk.ts сначала проверяет orphans,
--    затем создаёт + валидирует;
-- 3) идемпотентная проверка orphans + статуса FK живёт в TS-скрипте с
--    нормальным error reporting вместо PL/pgSQL RAISE WARNING.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app_auth;

CREATE TABLE IF NOT EXISTS app_auth.users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  email_confirmed_at timestamptz NULL,
  last_sign_in_at timestamptz NULL,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_disabled boolean NOT NULL DEFAULT false,
  banned_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  migrated_from text NULL,
  migrated_at timestamptz NULL
);

-- Уникальность email — case-insensitive. Код в local-auth.service.ts всегда
-- нормализует email через trim+lowercase перед INSERT/UPDATE/SELECT, но
-- функциональный индекс защищает от случая, если кто-то вставит данные
-- мимо сервиса (миграция/dump).
CREATE UNIQUE INDEX IF NOT EXISTS app_auth_users_email_lower_idx
  ON app_auth.users (lower(email));

COMMENT ON COLUMN app_auth.users.password_hash IS
  'bcrypt-хеш пароля. Поддерживаемые форматы: $2a$ (перенесённый Supabase encrypted_password), $2b$ (новые bcryptjs.hash), $2y$ (исторический PHP-формат). НИКОГДА не логировать содержимое колонки.';

COMMENT ON COLUMN app_auth.users.migrated_from IS
  'Источник записи при миграции (например, ''supabase.auth.users''). NULL для пользователей, созданных в новой системе.';

COMMENT ON COLUMN app_auth.users.migrated_at IS
  'Когда запись была перенесена из Supabase. NULL для пользователей, созданных в новой системе.';

-- Триггер автоматического обновления updated_at.
CREATE OR REPLACE FUNCTION app_auth.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_set_updated_at ON app_auth.users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON app_auth.users
  FOR EACH ROW EXECUTE FUNCTION app_auth.set_updated_at();

COMMIT;
