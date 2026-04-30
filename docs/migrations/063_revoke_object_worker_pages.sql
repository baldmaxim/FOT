-- 063_revoke_object_worker_pages.sql
-- Отзываем у роли worker (employee_variant='object') права на nested страницы
-- личного кабинета. Object-worker по дизайну работает только через
-- ObjectWorkerDashboardPage (/employee), без сайдбара и подразделов.
-- Лишние права приехали из миграции 016, где worker_object изначально получил
-- полный набор страниц вместе с worker_office, и сохранились через
-- переименование в 044_simplify_roles.

DELETE FROM role_page_access
WHERE role_code = 'worker'
  AND page_path IN (
    '/employee/requests',
    '/employee/payslips',
    '/employee/payments',
    '/employee/documents',
    '/employee/timesheet',
    '/employee/history',
    '/employee/salary-raise',
    '/employee/tasks'
  );
