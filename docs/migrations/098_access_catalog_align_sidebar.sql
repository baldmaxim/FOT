-- Migration 098: привести каталог access_pages в соответствие с боковым меню
-- Блоки Моё / Работа / Администрирование + свёрнутый «Технические доступы».
-- key/surface/supports_edit не меняются (route-гарды, контракт-тест);
-- обновляются label/group_code/group_label/sort_order. Устаревшие ключи удаляются.

BEGIN;

INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES
  -- Блок «Моё»
  ('/employee',                  'Личный кабинет',                        'mine',      'Моё',                 'page',      false, 10,  true),
  ('/employee/requests',         'Личный кабинет — Мои заявления',        'mine',      'Моё',                 'page',      true,  11,  true),
  ('/employee/documents',        'Личный кабинет — Мои документы',        'mine',      'Моё',                 'page',      true,  12,  true),
  ('/employee/tasks',            'Личный кабинет — Мои задачи',           'mine',      'Моё',                 'page',      true,  13,  true),
  ('/employee/salary-raise',     'Личный кабинет — Повышение оклада',     'mine',      'Моё',                 'page',      true,  14,  true),
  ('/dashboard',                 'Обзор',                                 'mine',      'Моё',                 'page',      false, 20,  true),
  ('/leave-requests',            'Заявления',                             'mine',      'Моё',                 'page',      true,  30,  true),
  ('/salary-raise-review',       'Заявления — Проверка повышений оклада', 'mine',      'Моё',                 'page',      true,  31,  true),
  ('/skud-presence',             'Сотрудники на объектах',                'mine',      'Моё',                 'page',      false, 40,  true),
  -- Блок «Работа»
  ('/staff-control',             'Управление кадрами',                    'work',      'Работа',              'page',      true,  100, true),
  ('/timesheet',                 'Табель',                                'work',      'Работа',              'page',      true,  110, true),
  ('/timesheet/events',          'Табель — события СКУД (вкладка дня)',   'work',      'Работа',              'technical', false, 115, true),
  ('/timesheet-hr',              'Согласования / Табели HR',              'work',      'Работа',              'page',      true,  120, true),
  ('/discipline',                'Аналитика',                             'work',      'Работа',              'page',      false, 130, true),
  ('/employees',                 'Карточка сотрудника',                   'work',      'Работа',              'page',      false, 140, true),
  ('/staff-control/department',  'Управление кадрами — смена отдела',     'work',      'Работа',              'technical', true,  161, true),
  ('/staff-control/position',    'Управление кадрами — смена должности',  'work',      'Работа',              'technical', true,  162, true),
  ('/staff-control/schedule',    'Управление кадрами — смена графика',    'work',      'Работа',              'technical', true,  163, true),
  -- Блок «Администрирование»
  ('/admin/schedules',           'Графики работы',                        'admin',     'Администрирование',   'page',      true,  200, true),
  ('/admin/schedules/templates', 'Графики работы — шаблоны (вкладка)',    'admin',     'Администрирование',   'technical', true,  205, true),
  ('/admin/patent-receipts',     'Чеки за патент',                        'admin',     'Администрирование',   'page',      true,  210, true),
  ('/admin/timesheet-transfers', 'Переводы и исключения',                 'admin',     'Администрирование',   'page',      true,  220, true),
  ('/skud-settings',             'СКУД',                                  'admin',     'Администрирование',   'page',      true,  230, true),
  ('/skud-db',                   'СКУД (база)',                           'admin',     'Администрирование',   'page',      false, 235, true),
  ('/skud-card-reader',          'Считыватель пропусков',                 'admin',     'Администрирование',   'page',      true,  240, true),
  ('/admin/users',               'Система — Управление пользователями',   'admin',     'Администрирование',   'page',      true,  250, true),
  ('/admin/roles',               'Система — Управление ролями',           'admin',     'Администрирование',   'page',      true,  251, true),
  ('/admin/audit',               'Система — Аудит данных',                'admin',     'Администрирование',   'page',      false, 252, true),
  ('/admin/action-history',      'Система — История действий',            'admin',     'Администрирование',   'page',      false, 253, true),
  ('/admin/settings',            'Система — Системные настройки',         'admin',     'Администрирование',   'page',      true,  254, true),
  ('/admin/data-api',            'Система — API-доступ к данным',         'admin',     'Администрирование',   'page',      true,  255, true),
  ('/admin/payslips',            'Управление расчётными листками',        'admin',     'Администрирование',   'page',      true,  260, true),
  -- Технический ключ без route-страницы
  ('timesheet-team-management',  'Управление составом табеля',            'technical', 'Технические доступы', 'technical', true,  285, true)
ON CONFLICT (key) DO UPDATE
SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- Удаляем устаревшие ключи, которых больше нет в каталоге
-- (/skud-travel, /skud-raw, /skud-monitor, /employee/payslips, /employee/payments,
--  /admin/payments и прочий прод-мусор от миграции 025).
DELETE FROM role_page_access
WHERE page_path NOT IN (
  '/employee', '/employee/requests', '/employee/documents', '/employee/tasks', '/employee/salary-raise',
  '/dashboard', '/leave-requests', '/salary-raise-review', '/skud-presence',
  '/staff-control', '/timesheet', '/timesheet/events', '/timesheet-hr', '/discipline', '/employees',
  '/staff-control/department', '/staff-control/position', '/staff-control/schedule',
  '/admin/schedules', '/admin/schedules/templates', '/admin/patent-receipts', '/admin/timesheet-transfers',
  '/skud-settings', '/skud-db', '/skud-card-reader',
  '/admin/users', '/admin/roles', '/admin/audit', '/admin/action-history', '/admin/settings', '/admin/data-api',
  '/admin/payslips', 'timesheet-team-management'
);

DELETE FROM access_pages
WHERE key NOT IN (
  '/employee', '/employee/requests', '/employee/documents', '/employee/tasks', '/employee/salary-raise',
  '/dashboard', '/leave-requests', '/salary-raise-review', '/skud-presence',
  '/staff-control', '/timesheet', '/timesheet/events', '/timesheet-hr', '/discipline', '/employees',
  '/staff-control/department', '/staff-control/position', '/staff-control/schedule',
  '/admin/schedules', '/admin/schedules/templates', '/admin/patent-receipts', '/admin/timesheet-transfers',
  '/skud-settings', '/skud-db', '/skud-card-reader',
  '/admin/users', '/admin/roles', '/admin/audit', '/admin/action-history', '/admin/settings', '/admin/data-api',
  '/admin/payslips', 'timesheet-team-management'
);

COMMIT;
