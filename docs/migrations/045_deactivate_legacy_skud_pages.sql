-- Migration 045: деактивация устаревших СКУД-страниц в каталоге access_pages
--
-- Страницы /skud-raw (Просмотр СКУД) и /skud-db (СКУД база) более неактуальны:
-- их функции покрываются SkudMonitorPage и источником Supabase напрямую.
-- Страницы остаются в БД и в App.tsx роутах для deep-link совместимости,
-- но больше не отображаются в боковом меню приложения.
--
-- role_page_access намеренно НЕ трогаем: записи остаются, чтобы
-- прямая ссылка `/skud-raw`/`/skud-db` продолжала работать у админов.

BEGIN;

UPDATE access_pages
SET
  is_active = FALSE,
  updated_at = NOW()
WHERE key IN ('/skud-raw', '/skud-db');

COMMIT;
