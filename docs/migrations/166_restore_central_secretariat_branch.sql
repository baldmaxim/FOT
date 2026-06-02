-- 166: Восстановление ветки «Центральный секретариат» после незавершённой
-- реорганизации в Sigur (01-02.06.2026).
--
-- Что произошло: при переводе курьеров/реорганизации в Sigur ветка секретариата
-- (Центральный секретариат 145804, Секретариат 142624, Секретариат-Объекты
-- 145807, Курьерская служба 142587) выпала из фида /api/v1/departments, и
-- reconciliation структурного синка пометил эти 4 отдела is_active=false, а
-- employee-синк увёл 12 сотрудников в корень компании «(СУ-10) ООО СУ-10»
-- (2cd8a403). Подробности — docs/diagnostics или план lively-splashing-gadget.
--
-- ВАЖНО: применять ПОСЛЕ деплоя код-защиты (гард A в sigur-sync-structure и
-- гард B′ в sigur-sync-employees), иначе ближайший синк (≤2 ч) откатит фикс.
--
-- Идемпотентно: повторный прогон ничего не меняет (все UPDATE защищены условиями
-- на текущее состояние). Историю employee_assignments скрипт НЕ переписывает —
-- видимость в отделе обеспечивают employees.org_department_id + снапшот
-- employee_department_access.

BEGIN;

-- 1) Реактивируем 4 отдела ветки.
UPDATE org_departments
   SET is_active = true, updated_at = now()
 WHERE id IN (
   'a372b95c-a53b-4619-a353-0fd286b47296',  -- Центральный секретариат
   '91dd729b-4491-4c47-b377-c6838e1887b4',  -- Секретариат
   '47f45cbb-c168-451a-90d0-0975de59f787',  -- Секретариат-Объекты
   'ab843e2d-98e3-4934-9954-367bc487334a'   -- Курьерская служба
 )
   AND is_active = false;

-- 2) Возвращаем сотрудников в их отделы (только если сейчас числятся в корне).
WITH target(employee_id, department_id) AS (VALUES
  (8781, '91dd729b-4491-4c47-b377-c6838e1887b4'::uuid),  -- Гейнц → Секретариат
  (1462, '91dd729b-4491-4c47-b377-c6838e1887b4'::uuid),  -- Расстрыгина → Секретариат
  (567,  '91dd729b-4491-4c47-b377-c6838e1887b4'::uuid),  -- Душанова → Секретариат
  (110,  '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),  -- Александрович → Секретариат-Объекты
  (984,  '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),  -- Лаптева
  (1093, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),  -- Матвеева
  (1392, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),  -- Пахомова
  (1665, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),  -- Смитская
  (2346, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),  -- Имаметдинова
  (2393, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),  -- Пацюкова
  (1417, 'ab843e2d-98e3-4934-9954-367bc487334a'::uuid),  -- Полещук → Курьерская служба
  (1980, 'ab843e2d-98e3-4934-9954-367bc487334a'::uuid)   -- Хащеватский → Курьерская служба
)
UPDATE employees e
   SET org_department_id = t.department_id, updated_at = now()
  FROM target t
 WHERE e.id = t.employee_id
   AND e.org_department_id = '2cd8a403-6454-408b-9c2b-8a2db65c7511';

-- 3a) Снапшот членства: реактивируем строки в листовых отделах ветки.
WITH target(employee_id, department_id) AS (VALUES
  (8781, '91dd729b-4491-4c47-b377-c6838e1887b4'::uuid),
  (1462, '91dd729b-4491-4c47-b377-c6838e1887b4'::uuid),
  (567,  '91dd729b-4491-4c47-b377-c6838e1887b4'::uuid),
  (110,  '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),
  (984,  '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),
  (1093, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),
  (1392, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),
  (1665, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),
  (2346, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),
  (2393, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid),
  (1417, 'ab843e2d-98e3-4934-9954-367bc487334a'::uuid),
  (1980, 'ab843e2d-98e3-4934-9954-367bc487334a'::uuid)
)
UPDATE employee_department_access eda
   SET is_active = true, updated_at = now()
  FROM target t
 WHERE eda.employee_id = t.employee_id
   AND eda.department_id = t.department_id
   AND eda.is_active = false;

-- 3b) Гасим ошибочные членства на корень компании (созданы sigur_sync при инциденте).
UPDATE employee_department_access
   SET is_active = false, updated_at = now()
 WHERE employee_id IN (8781,1462,567,110,984,1093,1392,1665,2346,2393,1417,1980)
   AND department_id = '2cd8a403-6454-408b-9c2b-8a2db65c7511'
   AND source = 'sigur_sync'
   AND is_active = true;

-- 4) Контроль.
DO $$
DECLARE sekr int; sekrobj int; courier int; still_inactive int; still_root int;
BEGIN
  SELECT count(*) INTO sekr FROM employees
   WHERE org_department_id = '91dd729b-4491-4c47-b377-c6838e1887b4'
     AND is_archived = false AND employment_status <> 'fired';
  SELECT count(*) INTO sekrobj FROM employees
   WHERE org_department_id = '47f45cbb-c168-451a-90d0-0975de59f787'
     AND is_archived = false AND employment_status <> 'fired';
  SELECT count(*) INTO courier FROM employees
   WHERE org_department_id = 'ab843e2d-98e3-4934-9954-367bc487334a'
     AND is_archived = false AND employment_status <> 'fired';
  SELECT count(*) INTO still_inactive FROM org_departments
   WHERE id IN ('a372b95c-a53b-4619-a353-0fd286b47296','91dd729b-4491-4c47-b377-c6838e1887b4',
                '47f45cbb-c168-451a-90d0-0975de59f787','ab843e2d-98e3-4934-9954-367bc487334a')
     AND is_active = false;
  SELECT count(*) INTO still_root FROM employees
   WHERE id IN (8781,1462,567,110,984,1093,1392,1665,2346,2393,1417,1980)
     AND org_department_id = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
  RAISE NOTICE '166: Секретариат=% (ожид>=3), Секретариат-Объекты=% (ожид>=7), Курьерская служба=% (ожид>=2)', sekr, sekrobj, courier;
  RAISE NOTICE '166: ещё неактивных из 4 отделов ветки = % (ожид 0); сотрудников осталось в корне = % (ожид 0)', still_inactive, still_root;
END $$;

COMMIT;
