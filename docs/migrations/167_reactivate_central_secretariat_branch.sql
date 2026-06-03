-- 167: Повторная реактивация ветки «Центральный секретариат».
--
-- Зачем отдельно от 166: миграция 166 уже записана в schema_migrations и
-- раннером повторно не накатывается. После 166 структурный синк на СТАРОМ коде
-- (до деплоя гардов A/B′, релиз c72e1b1 от 2026-06-03 11:27) снова пометил эти
-- отделы is_active=false (фид Sigur /api/v1/departments их не возвращает).
-- Сотрудники при этом остались на местах (Секретариат=3, Секретариат-Объекты=7).
--
-- Гард A (не гасит населённые отделы и их предков) уже в рантайме — поэтому
-- разовая реактивация теперь устоит: ближайший reconciliation их не погасит.
--
-- ВАЖНО: применять ТОЛЬКО когда в рантайме код с гардами (release c72e1b1+,
-- НЕ bb20096). Иначе ближайший синк снова погасит.
-- Идемпотентно: повторный прогон ничего не меняет.

BEGIN;

-- 1) Реактивируем 3 отдела ветки (родитель + два листа с людьми).
UPDATE org_departments
   SET is_active = true, updated_at = now()
 WHERE id IN (
   'a372b95c-a53b-4619-a353-0fd286b47296',  -- Центральный секретариат
   '91dd729b-4491-4c47-b377-c6838e1887b4',  -- Секретариат
   '47f45cbb-c168-451a-90d0-0975de59f787'   -- Секретариат-Объекты
 )
   AND is_active = false;

-- 2) Снапшот членства (идемпотентно, на случай если синк его тронул):
--    реактивируем листовые строки, гасим ошибочные строки на корень.
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
  (2393, '47f45cbb-c168-451a-90d0-0975de59f787'::uuid)
)
UPDATE employee_department_access eda
   SET is_active = true, updated_at = now()
  FROM target t
 WHERE eda.employee_id = t.employee_id
   AND eda.department_id = t.department_id
   AND eda.is_active = false;

UPDATE employee_department_access
   SET is_active = false, updated_at = now()
 WHERE employee_id IN (8781,1462,567,110,984,1093,1392,1665,2346,2393)
   AND department_id = '2cd8a403-6454-408b-9c2b-8a2db65c7511'
   AND source = 'sigur_sync'
   AND is_active = true;

-- 3) Контроль.
DO $$
DECLARE still_inactive int; sekr int; sekrobj int;
BEGIN
  SELECT count(*) INTO still_inactive FROM org_departments
   WHERE id IN ('a372b95c-a53b-4619-a353-0fd286b47296','91dd729b-4491-4c47-b377-c6838e1887b4',
                '47f45cbb-c168-451a-90d0-0975de59f787')
     AND is_active = false;
  SELECT count(*) INTO sekr FROM employees
   WHERE org_department_id='91dd729b-4491-4c47-b377-c6838e1887b4' AND is_archived=false AND employment_status<>'fired';
  SELECT count(*) INTO sekrobj FROM employees
   WHERE org_department_id='47f45cbb-c168-451a-90d0-0975de59f787' AND is_archived=false AND employment_status<>'fired';
  RAISE NOTICE '167: неактивных из 3 отделов = % (ожид 0); Секретариат=% (ожид>=3); Секретариат-Объекты=% (ожид>=7)', still_inactive, sekr, sekrobj;
END $$;

COMMIT;
