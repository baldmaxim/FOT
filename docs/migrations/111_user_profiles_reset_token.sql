-- 111_user_profiles_reset_token.sql
-- Возвращает колонки для потока «Забыли пароль». Обработчик
-- POST /auth/forgot-password (auth.controller.ts → forgotPassword) пишет в
-- public.user_profiles SHA-256 хэш одноразового токена и срок его жизни, а
-- POST /auth/reset-password ищет профиль по этому хэшу.
--
-- До миграции Supabase → Yandex (Phase 11+12) колонки существовали в
-- Supabase-схеме (добавленные через UI), но в репозиторных миграциях их не
-- было — после переезда на Yandex PG UPDATE падал с
-- "column reset_token does not exist", и пользователь видел 500.
--
-- Применяется ВРУЧНУЮ на проде:
--   psql "$DATABASE_URL" -f docs/migrations/111_user_profiles_reset_token.sql

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS reset_token         TEXT,
  ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

-- Частичный UNIQUE-индекс: у активных пользователей токен NULL и допускает
-- много NULL'ов; одновременно гарантирует, что один и тот же sha256-хэш не
-- будет привязан к двум профилям, и ускоряет SELECT ... WHERE reset_token=$1.
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_reset_token_idx
  ON public.user_profiles (reset_token)
  WHERE reset_token IS NOT NULL;
