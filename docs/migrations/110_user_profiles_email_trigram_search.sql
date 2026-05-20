-- 110_user_profiles_email_trigram_search.sql
-- Триграммные GIN-индексы для быстрого ILIKE по ФИО и e-mail в админке
-- (/admin/system?tab=users → поиск). Без них roleCounts + paginated делают
-- двойной seq-scan user_profiles + EXISTS-подзапрос на app_auth.users по
-- каждой кандидатной строке — на тысячах пользователей это секунды на каждое
-- нажатие клавиши.
--
-- Применяется ВРУЧНУЮ на проде (авто-миграций нет):
--   psql "$DATABASE_URL" -f docs/migrations/110_user_profiles_email_trigram_search.sql
--
-- Индексы создаются CONCURRENTLY чтобы не блокировать таблицы под нагрузкой;
-- IF NOT EXISTS делает миграцию идемпотентной.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_full_name_trgm
  ON public.user_profiles USING gin (full_name gin_trgm_ops)
  WHERE full_name IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_app_auth_users_email_trgm
  ON app_auth.users USING gin (email gin_trgm_ops)
  WHERE email IS NOT NULL;
