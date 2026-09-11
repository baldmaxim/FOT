-- 275: Раздел «Зарплата» — ключи доступа вкладок «Больничные», «Отпуска», «Удержания».
--
-- Раздел состоит из вкладок Выплаты / Больничные / Отпуска / Удержания. «Выплаты» закрыта
-- ключами /salary/payments и /salary/terms из миграции 272; здесь — остальные три вкладки.
-- Сами расчёты в них появятся на этапе 4, но вкладки видны уже сейчас, и у каждой свой ключ,
-- чтобы позже раздать их разным ролям через админку без миграции и деплоя.
--
-- Права — ТОЛЬКО роли admin, как и у остальных ключей раздела.
--
-- group_code обязан совпадать с DEFAULT_ACCESS_PAGE_CATALOG в
-- fot-server/src/config/access-control.ts: запись в БД переопределяет программный каталог.
--
-- Номера 273 и 274 заняты чёрным списком (273_person_blacklist.sql, 274_person_blacklist_memos.sql).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА И ФРОНТЕНДА. Повторный запуск безопасен.

BEGIN;

INSERT INTO access_pages
  (key, label, group_code, group_label, area, surface, supports_edit, sort_order, is_active, is_system)
VALUES
  ('/salary/sick-leaves', 'Зарплата — Больничные', 'admin', 'Администрирование', 'admin', 'page', true, 275, true, true),
  ('/salary/vacations',   'Зарплата — Отпуска',    'admin', 'Администрирование', 'admin', 'page', true, 276, true, true),
  ('/salary/deductions',  'Зарплата — Удержания',  'admin', 'Администрирование', 'admin', 'page', true, 277, true, true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  area = EXCLUDED.area,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-- Только admin. Уже выданные вручную права других ролей повторный прогон не трогает.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT 'admin', k, true, true
  FROM unnest(ARRAY['/salary/sick-leaves', '/salary/vacations', '/salary/deductions']) AS k
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = true, can_edit = true;

COMMIT;
