-- 294: Раздел «Зарплата» — ключ вкладки «Администрирование» и грант на весь раздел.
--
-- Вкладка «Администрирование» (после «Расчёт и выплаты», экран ?view=admin) — пока заглушка,
-- позже здесь настраивается подключение по API к 1С и другим системам. Свой ключ
-- /salary/admin, чтобы роли выдавать её отдельно от расчёта.
--
-- Права по роли — ТОЛЬКО admin, как у остальных ключей раздела (272, 275).
--
-- Персональный грант «Зарплата» (миграция 288, «Назначения сотрудников») теперь открывает
-- весь раздел, а не только /salary/terms: список ключей — PAYROLL_GRANT_PAGES в
-- fot-server/src/services/payroll/payroll-access.service.ts. Таблица не меняется, обновляется
-- только её комментарий.
--
-- group_code обязан совпадать с DEFAULT_ACCESS_PAGE_CATALOG в
-- fot-server/src/config/access-control.ts: запись в БД переопределяет программный каталог.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА И ФРОНТЕНДА. Повторный запуск безопасен.

BEGIN;

INSERT INTO access_pages
  (key, label, group_code, group_label, area, surface, supports_edit, sort_order, is_active, is_system)
VALUES
  ('/salary/admin', 'Зарплата — Администрирование', 'admin', 'Администрирование', 'admin', 'technical', true, 278, true, true)
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
VALUES ('admin', '/salary/admin', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = true, can_edit = true;

COMMENT ON TABLE public.payroll_access_grants IS
  'Персональный доступ ко всему разделу «Зарплата» (ключи /salary/*, список — PAYROLL_GRANT_PAGES) на весь штат: view | edit.';

COMMIT;
