-- Удаляет таблицы псевдонимов Excel-импорта назначений.
-- Вкладка «Импорт назначений» (UserManagementPage → 'import') удалена вместе
-- с backend-эндпоинтами /admin/users/department-access-import/* и
-- сервисом fot-server/src/services/manager-department-import.service.ts.
-- Сами таблицы были созданы в миграции 033_manager_department_import_aliases.sql.

DROP TABLE IF EXISTS public.manager_department_import_brigade_aliases;
DROP TABLE IF EXISTS public.manager_department_import_employee_aliases;
