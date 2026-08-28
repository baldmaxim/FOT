-- Одноразовый ремонт данных: вернуть штатному Дмитриеву А.А. (employees.id = 548) отдел УОК
-- после ошибочного увольнения 14.08.2026 как «дубля» подрядчика (пропуск ИЛОН 5411).
-- Синк Sigur вернул active + org_department_id, но не оживил привязку к отделу, оставил
-- открытое назначение «Уволенные» с 15.08 и метку dismissal_apply_started_at.
--
-- Запуск на проде:  psql "$DATABASE_URL" -f restore-dmitriev-548.sql
-- Любое расхождение с ожидаемым состоянием → RAISE EXCEPTION, транзакция откатывается.
-- Заявки 7083/7084 скрипт не трогает — согласовать штатно через интерфейс.
-- УДАЛИТЬ ФАЙЛ ПОСЛЕ ПРИМЕНЕНИЯ.

\set ON_ERROR_STOP on

BEGIN;

DO $repair$
DECLARE
  n int;
  c_emp   constant bigint := 548;
  c_uok   constant uuid   := '3ad4aa9f-d988-4c49-bc52-abb74ef74bd9'; -- Управление объективного контроля
  c_fired constant uuid   := 'a24ecc09-a414-494b-982e-f67f0f5be287'; -- назначение «Уволенные» с 15.08
  c_open  constant uuid   := 'a858a4c0-f824-454d-a1b3-6c3f9d5ac4a5'; -- назначение УОК 01.01–14.08
BEGIN
  PERFORM 1 FROM employees WHERE id = c_emp FOR UPDATE;
  PERFORM 1 FROM employee_assignments WHERE employee_id = c_emp FOR UPDATE;

  -- Предусловие: сотрудник уже активен и числится в УОК.
  SELECT count(*) INTO n FROM employees
   WHERE id = c_emp
     AND employment_status = 'active'
     AND dismissal_date IS NULL
     AND is_archived = false
     AND org_department_id = c_uok;
  IF n <> 1 THEN
    RAISE EXCEPTION 'employees %: состояние отличается от ожидаемого (active, без увольнения, УОК)', c_emp;
  END IF;

  -- 1. Сначала убрать ложное открытое назначение «Уволенные» (иначе сработает защита от пересечения периодов).
  DELETE FROM employee_assignments
   WHERE id = c_fired AND employee_id = c_emp
     AND org_department_id <> c_uok
     AND effective_from = DATE '2026-08-15'
     AND effective_to IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'назначение «Уволенные» % не найдено в ожидаемом состоянии', c_fired;
  END IF;

  -- 2. Переоткрыть прежнее назначение УОК.
  UPDATE employee_assignments
     SET effective_to = NULL, updated_at = now()
   WHERE id = c_open AND employee_id = c_emp
     AND org_department_id = c_uok
     AND effective_to = DATE '2026-08-14';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'назначение УОК % не найдено в ожидаемом состоянии (effective_to = 2026-08-14)', c_open;
  END IF;

  -- 3. Оживить техническую привязку к отделу — по ней руководитель получает право согласования.
  UPDATE employee_department_access
     SET is_active = true, updated_at = now()
   WHERE employee_id = c_emp AND department_id = c_uok AND source = 'sigur_sync';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'привязка sigur_sync к УОК для % не найдена', c_emp;
  END IF;

  -- 4. Снять метку «увольнение в работе».
  UPDATE employees
     SET dismissal_apply_started_at = NULL, updated_at = now()
   WHERE id = c_emp;

  -- Постусловие: ровно одно открытое назначение, и это УОК.
  SELECT count(*) INTO n FROM employee_assignments WHERE employee_id = c_emp AND effective_to IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'после ремонта открытых назначений: % (ожидалось 1)', n;
  END IF;
  SELECT count(*) INTO n FROM employee_assignments
   WHERE employee_id = c_emp AND effective_to IS NULL AND org_department_id = c_uok;
  IF n <> 1 THEN
    RAISE EXCEPTION 'после ремонта открытое назначение не в УОК';
  END IF;

  RAISE NOTICE 'Дмитриев % восстановлен в УОК', c_emp;
END
$repair$;

-- История: парная запись «восстановлен» к увольнению 14.08 (идемпотентно, только для карточки).
INSERT INTO employee_dismissal_events (employee_id, dismissal_date, scheduled, rehired, prev_date, reason)
SELECT 548, DATE '2026-08-14', false, true, DATE '2026-08-14',
       'Ошибочное увольнение как дубля подрядчика (пропуск 5411) — восстановлен'
 WHERE NOT EXISTS (
   SELECT 1 FROM employee_dismissal_events
    WHERE employee_id = 548 AND rehired = true AND prev_date = DATE '2026-08-14'
 );

COMMIT;

-- Контроль после применения:
SELECT department_id, source, is_active FROM employee_department_access WHERE employee_id = 548;
SELECT org_department_id, effective_from, effective_to FROM employee_assignments WHERE employee_id = 548 ORDER BY effective_from;
SELECT employment_status, dismissal_date, dismissal_apply_started_at FROM employees WHERE id = 548;
