-- 242_object_kpi_pages_and_economist.sql
-- Страницы и роль для модуля «KPI закрытия КС-2» (см. 241_object_kpi_ks2.sql).
--
-- Каталог страниц живёт в ДВУХ местах одновременно: таблица public.access_pages и
-- DEFAULT_ACCESS_PAGE_CATALOG в fot-server/src/config/access-control.ts. Миграция
-- обязана заполнить оба, иначе права разъедутся между БД и кодом.
--
-- Модуль добавляет ровно два ключа:
--   /discipline/objects — вкладка «KPI объектов» на странице «Аналитика» (ввод + отчёт),
--   /employee/objects   — раздел «Объекты» в ЛК руководителя строительства (только чтение).
-- Отдельной страницы «Объекты строительства» нет: и ведение данных, и закрепление живут
-- на вкладке, закрепление — модалкой.
--
-- «Руководитель экономического отдела» системной ролью НЕ заводится: system_role_id у
-- пользователя один, и такая роль отобрала бы у человека текущую. Он получает доступ
-- авто-грантом по активной записи в object_kpi_global_roles (access-control.service.ts).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- ── 1. Каталог страниц ──────────────────────────────────────────────────────
-- /discipline/objects: supports_edit = true — на вкладке экономист вводит договоры,
-- допсоглашения и акты КС-2. area='admin', группа «Управление» — рядом с /discipline.
-- /employee/objects: личный кабинет, только просмотр.
INSERT INTO access_pages (
  key, label, group_code, group_label, area, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system
)
VALUES
  ('/discipline/objects', 'Аналитика — KPI объектов (вкладка)', 'work', 'Управление',
   'admin', 'page', true, false, false, 133, true, true),
  ('/employee/objects', 'Мои объекты (KPI)', 'lk', 'Личный кабинет',
   'personal', 'page', false, false, false, 20, true, true)
ON CONFLICT (key) DO UPDATE SET
  label       = EXCLUDED.label,
  group_code  = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  area        = EXCLUDED.area,
  surface     = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order  = EXCLUDED.sort_order,
  is_active   = true;

-- ── 2. Роль «Экономист» ─────────────────────────────────────────────────────
-- admin_access = true обязателен: без него гейт в access-control.service.ts отбросит
-- роль-грант на страницу области admin. Именно эту строку пришлось доливать для
-- роли mts_manager отдельной миграцией 221.
INSERT INTO system_roles (
  code, name, description, is_admin, employee_variant, is_active,
  admin_access, manager_auto_access
)
VALUES (
  'economist', 'Экономист',
  'Ведение договоров, допсоглашений и актов КС-2 по объектам строительства; отчёт KPI',
  false, 'office', true, true, false
)
ON CONFLICT (code) DO UPDATE SET
  name                = EXCLUDED.name,
  description         = EXCLUDED.description,
  is_admin            = false,
  employee_variant    = EXCLUDED.employee_variant,
  is_active           = true,
  admin_access        = true,
  manager_auto_access = false;

-- ── 3. Гранты ───────────────────────────────────────────────────────────────
-- Экономисту НЕ даём '/discipline': иначе он увидит вкладку дисциплины. Роут
-- «Аналитики» защищён массивом ['/discipline','/discipline/objects'] (любой из ключей),
-- а HubShell отфильтрует вкладки по правам. '/dashboard' тоже не даём — это общий
-- обзор компании.
-- Набор ключей ЛК скопирован с роли mts_manager (миграция 219).
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('economist',   '/discipline/objects',  true, true),
  ('economist',   '/employee',            true, false),
  ('economist',   '/employee/documents',  true, true),
  ('economist',   '/employee/requests',   true, true),
  ('economist',   '/employee/tasks',      true, true),
  ('economist',   '/employee/feedback',   true, true),
  ('economist',   '/employee/phonebook',  true, false),
  ('economist',   '/employee/sim',        true, false),
  -- Руководитель строительства видит только свои закреплённые объекты — в ЛК.
  -- Вкладку «KPI объектов» ему не даём: там чужие проценты и ввод данных.
  ('manager_obj', '/employee/objects',    true, false)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

COMMIT;
