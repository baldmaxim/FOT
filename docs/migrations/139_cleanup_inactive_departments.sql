-- 139_cleanup_inactive_departments.sql
-- Чистка «лишних» отделов из org_departments: физически удаляет неактивные
-- (is_active=false) sigur-отделы — это фантомы (удалены в Sigur) и дубли пере-
-- синков (напр. ~15× «Фабрика витражей», «Отдел автотехники» ×2, закрытые
-- бригады «…/закр», «Тест», «ИТОГО: 2 231», «г.Владимир (окна)»). Появлялись
-- в дереве «Отделы для статистики» на дашборде HR, т.к. запрос дашборда не
-- фильтровал is_active.
--
-- Безопасность: на момент написания все такие строки ПОЛНОСТЬЮ осиротевшие
-- (0 ссылок во всех таблицах). FK-констрейнтов на org_departments в БД нет,
-- поэтому удаляем только строки, на которые НИКТО не ссылается — NOT EXISTS по
-- всем известным колонкам-ссылкам + отсутствие детей. Идемпотентно и безопасно
-- даже если часть строк успела обзавестись ссылками.
--
-- Не вернутся после удаления: sync пропускает не-whitelist отделы (whitelist-
-- фильтр) и не реактивирует фантомы (их нет в свежем ответе Sigur).
-- Ручные отделы (sigur_department_id IS NULL) НЕ трогаем.

DELETE FROM org_departments d
WHERE d.is_active = false
  AND d.sigur_department_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM employees x              WHERE x.org_department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM employee_assignments x   WHERE x.org_department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM employee_department_access x WHERE x.department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM timesheet_approvals x    WHERE x.department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM timesheet_approval_events x WHERE x.department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM timesheet_responsibles x WHERE x.department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM timesheet_reminder_log x WHERE x.department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM org_sites x              WHERE x.department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM skud_access_point_settings x WHERE x.department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM contractor_documents x   WHERE x.org_department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM contractor_org_access x  WHERE x.org_department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM contractor_passes x      WHERE x.org_department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM contractor_roster x      WHERE x.org_department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM contractor_submissions x WHERE x.org_department_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM org_departments c        WHERE c.parent_id = d.id);
