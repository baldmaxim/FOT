-- 074_drop_manager_schedules_default_access.sql
--
-- Снимает дефолтный доступ роли 'manager' к виртуальной странице
-- /admin/schedules/templates, который выдала миграция 070.
--
-- Причина: из-за этого дефолта админ не мог снять доступ к «Графикам работы»
-- через основную матрицу прав (страница продолжала открываться через
-- технический путь, OR-логика гардов пропускала). После этой миграции
-- admin-UI становится единственным источником истины: по умолчанию у
-- руководителя нет доступа, любые права выдаёт админ явно через матрицу
-- ролей (включая «режим только шаблонов» через «Технические доступы»).
--
-- Применяется вручную через psql на проде:
--   psql "$DATABASE_URL" -f docs/migrations/074_drop_manager_schedules_default_access.sql

BEGIN;

DELETE FROM role_page_access
WHERE role_code = 'manager'
  AND page_path = '/admin/schedules/templates';

COMMIT;
