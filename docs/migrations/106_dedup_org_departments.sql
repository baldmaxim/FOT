-- 106_dedup_org_departments.sql
--
-- Проблема: Sigur периодически пересоздаёт компанию с НОВЫМИ sigur-id
-- (наблюдалось «(СУ-10) ООО СУ-10»: старая sigur=140659 → новая 142365),
-- whitelist деактивирует старое 140xxx-поддерево. sigur-sync-structure
-- апсертит строго по sigur_department_id и НЕ схлопывает одноимённые строки
-- при смене sigur-id → в org_departments остаются осиротевшие is_active=false
-- дубликаты, а часть сотрудников «застревает» на них. Массовое назначение
-- графика по бригадам молча пропускает таких сотрудников.
--
-- На момент написания: 103 пары orphan→canonical, 32 активных сотрудника
-- застряли на is_active=false, 0 дублей sigur_department_id.
--
-- Эта миграция (одноразово, ВРУЧНУЮ через psql на проде):
--   1) схлопывает orphan-строки на одноимённую активную (canonical):
--      перепривязывает ВСЕ FK, затем удаляет orphan-строки;
--   2) ставит партиальный UNIQUE-индекс на sigur_department_id
--      (защита от будущих дублей; работает в паре с ON CONFLICT в
--      sigur-sync-structure.service.ts и consolidateDuplicateDepartments()).
--
-- Маппинг (ИДЕНТИЧЕН consolidateDuplicateDepartments() и
-- fot-server/scripts/diagnose-dup-departments.mjs): для каждого name, у
-- которого РОВНО одна is_active=false строка с sigur_department_id IS NOT NULL
-- и РОВНО одна is_active=true строка — orphan=inactive, canonical=active.
-- Неоднозначные имена (>1 активная или иные комбинации) НЕ трогаются и
-- выводятся в конце для ручного разбора.
--
-- Откат: вся миграция в одной транзакции. Перед COMMIT глазами проверить
-- блок «КОНТРОЛЬ ПОСЛЕ»; при сомнении — ROLLBACK.

BEGIN;

-- Маппинг orphan → canonical во временную таблицу.
CREATE TEMP TABLE dept_dedup_map ON COMMIT DROP AS
WITH dup AS (
  SELECT name FROM org_departments
   GROUP BY name
  HAVING count(*) FILTER (WHERE is_active = false AND sigur_department_id IS NOT NULL) = 1
     AND count(*) FILTER (WHERE is_active = true) = 1
)
SELECT orphan.id AS orphan_id, canon.id AS canonical_id, orphan.name AS name
  FROM dup
  JOIN org_departments orphan
    ON orphan.name = dup.name AND orphan.is_active = false AND orphan.sigur_department_id IS NOT NULL
  JOIN org_departments canon
    ON canon.name = dup.name AND canon.is_active = true;

CREATE INDEX ON dept_dedup_map (orphan_id);

-- КОНТРОЛЬ ДО.
\echo '== пар orphan->canonical =='
SELECT count(*) AS pairs FROM dept_dedup_map;
\echo '== активных сотрудников на is_active=false (до) =='
SELECT count(*) AS stranded_before
  FROM employees e JOIN org_departments od ON od.id = e.org_department_id
 WHERE od.is_active = false
   AND e.is_archived = false AND e.excluded_from_timesheet = false AND e.employment_status <> 'fired';

-- 1. Перепривязка FK без unique-конфликта по колонке отдела (только PK на id).
UPDATE employees t              SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id;
UPDATE employee_assignments t   SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id;
UPDATE contractor_submissions t SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id;
UPDATE contractor_org_access t  SET org_department_id = m.canonical_id FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id;
UPDATE org_sites t              SET department_id     = m.canonical_id FROM dept_dedup_map m WHERE t.department_id     = m.orphan_id;
UPDATE timesheet_approval_events t SET department_id  = m.canonical_id FROM dept_dedup_map m WHERE t.department_id     = m.orphan_id;
UPDATE timesheet_approvals t    SET department_id     = m.canonical_id FROM dept_dedup_map m WHERE t.department_id     = m.orphan_id;
UPDATE manager_department_import_brigade_aliases t
                                SET department_id     = m.canonical_id FROM dept_dedup_map m WHERE t.department_id     = m.orphan_id;
-- дети осиротевших отделов → на canonical-родителя
UPDATE org_departments t        SET parent_id         = m.canonical_id FROM dept_dedup_map m WHERE t.parent_id         = m.orphan_id;

-- 2. Перепривязка с защитой от UNIQUE-конфликта: сперва удаляем orphan-строки,
--    которые столкнулись бы с уже существующей canonical-строкой, затем UPDATE.

-- employee_department_access: UNIQUE (employee_id, department_id)
DELETE FROM employee_department_access t USING dept_dedup_map m
 WHERE t.department_id = m.orphan_id
   AND EXISTS (SELECT 1 FROM employee_department_access x
                WHERE x.department_id = m.canonical_id AND x.employee_id = t.employee_id);
UPDATE employee_department_access t SET department_id = m.canonical_id
  FROM dept_dedup_map m WHERE t.department_id = m.orphan_id;

-- timesheet_responsibles: UNIQUE (department_id, role)
DELETE FROM timesheet_responsibles t USING dept_dedup_map m
 WHERE t.department_id = m.orphan_id
   AND EXISTS (SELECT 1 FROM timesheet_responsibles x
                WHERE x.department_id = m.canonical_id AND x.role = t.role);
UPDATE timesheet_responsibles t SET department_id = m.canonical_id
  FROM dept_dedup_map m WHERE t.department_id = m.orphan_id;

-- user_company_access: UNIQUE (user_id, company_root_id)
DELETE FROM user_company_access t USING dept_dedup_map m
 WHERE t.company_root_id = m.orphan_id
   AND EXISTS (SELECT 1 FROM user_company_access x
                WHERE x.company_root_id = m.canonical_id AND x.user_id = t.user_id);
UPDATE user_company_access t SET company_root_id = m.canonical_id
  FROM dept_dedup_map m WHERE t.company_root_id = m.orphan_id;

-- contractor_passes: UNIQUE (org_department_id, pass_number)
DELETE FROM contractor_passes t USING dept_dedup_map m
 WHERE t.org_department_id = m.orphan_id
   AND EXISTS (SELECT 1 FROM contractor_passes x
                WHERE x.org_department_id = m.canonical_id AND x.pass_number = t.pass_number);
UPDATE contractor_passes t SET org_department_id = m.canonical_id
  FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id;

-- contractor_roster: UNIQUE (org_department_id, sigur_employee_id) WHERE sigur_employee_id IS NOT NULL
DELETE FROM contractor_roster t USING dept_dedup_map m
 WHERE t.org_department_id = m.orphan_id
   AND t.sigur_employee_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM contractor_roster x
                WHERE x.org_department_id = m.canonical_id AND x.sigur_employee_id = t.sigur_employee_id);
UPDATE contractor_roster t SET org_department_id = m.canonical_id
  FROM dept_dedup_map m WHERE t.org_department_id = m.orphan_id;

-- 3. timesheet_reminder_log — журнал напоминаний (ON DELETE CASCADE, без
--    ценности для дефунктного отдела, UNIQUE по dept+period+user+stage):
--    просто удаляем строки, ссылающиеся на orphan.
DELETE FROM timesheet_reminder_log t USING dept_dedup_map m
 WHERE t.department_id = m.orphan_id;

-- 4. Orphan-строки больше никем не используются → удаляем.
DELETE FROM org_departments WHERE id IN (SELECT orphan_id FROM dept_dedup_map);

-- 5. Партиальный UNIQUE на sigur_department_id (защита от будущих дублей).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_departments_sigur
  ON org_departments (sigur_department_id) WHERE sigur_department_id IS NOT NULL;

-- КОНТРОЛЬ ПОСЛЕ (всё должно быть 0 / пусто).
\echo '== активных сотрудников на is_active=false (после, ожидается 0) =='
SELECT count(*) AS stranded_after
  FROM employees e JOIN org_departments od ON od.id = e.org_department_id
 WHERE od.is_active = false
   AND e.is_archived = false AND e.excluded_from_timesheet = false AND e.employment_status <> 'fired';

\echo '== имён с активными сотрудниками на >1 строке (после, ожидается 0) =='
SELECT count(*) AS split_names FROM (
  SELECT od.name FROM org_departments od
   JOIN employees e ON e.org_department_id = od.id
    AND e.is_archived = false AND e.excluded_from_timesheet = false AND e.employment_status <> 'fired'
   GROUP BY od.name HAVING count(DISTINCT od.id) > 1) z;

\echo '== дубли sigur_department_id (ожидается 0) =='
SELECT count(*) AS dup_sigur FROM (
  SELECT sigur_department_id FROM org_departments
   WHERE sigur_department_id IS NOT NULL
   GROUP BY sigur_department_id HAVING count(*) > 1) z;

\echo '== НЕОДНОЗНАЧНЫЕ имена (НЕ тронуты, ручной разбор) =='
SELECT name,
       count(*) FILTER (WHERE is_active) AS actives,
       count(*) FILTER (WHERE NOT is_active) AS inactives,
       count(*) FILTER (WHERE NOT is_active AND sigur_department_id IS NOT NULL) AS inactive_with_sigur
  FROM org_departments
 GROUP BY name HAVING count(*) > 1
 ORDER BY name;

COMMIT;
