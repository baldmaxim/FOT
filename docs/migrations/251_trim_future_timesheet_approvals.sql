-- Обрезка подач табеля, поданных за ещё не завершённый период (август 2026, 01–31).
--
-- Причина: гард «подавать можно только завершённый полупериод» обходился флагом роли
-- timesheet_show_full_period, а он включён у всех ролей. Подача в режиме «Весь месяц»
-- (и авто-self-personal подача руководителя с тем же диапазоном) закрывала замком
-- 16–31 августа — дни, которые ещё ведутся. Урезаем end_date до 15.08: утверждение
-- первой половины сохраняется, вторая открывается, переподавать ничего не нужно.
--
-- Применять ПОСЛЕ выката бэкенда с новым гардом (isRangeWithinCompletedPeriods),
-- иначе старый код позволит немедленно подать весь август заново.
-- После применения — перезапуск бэкенда (кэш ответов /api/timesheet).

BEGIN;

CREATE TABLE IF NOT EXISTS migration_251_backup AS
SELECT * FROM timesheet_approvals WHERE 1 = 0;

DO $$
DECLARE
  expected CONSTANT int := 5;
  found    int;
  affected int;
BEGIN
  -- Ровно 5 ожидаемых строк: диапазон, статус, тип скоупа и отсутствие ручного открытия.
  SELECT count(*) INTO found
    FROM timesheet_approvals
   WHERE id IN (1300, 1301, 1358, 1359, 1378)
     AND start_date = DATE '2026-08-01'
     AND end_date   = DATE '2026-08-31'
     AND status IN ('submitted', 'approved')
     AND unlocked_at IS NULL
     AND (
       (id IN (1300, 1358) AND department_id IS NOT NULL AND manager_employee_id IS NULL)
       OR (id IN (1301, 1359, 1378) AND department_id IS NULL AND manager_employee_id IS NOT NULL)
     );

  IF found <> expected THEN
    RAISE EXCEPTION 'Ожидалось % подходящих подач, найдено % — прод разошёлся с планом, миграция отменена', expected, found;
  END IF;

  INSERT INTO migration_251_backup
  SELECT * FROM timesheet_approvals WHERE id IN (1300, 1301, 1358, 1359, 1378);

  UPDATE timesheet_approvals
     SET end_date = DATE '2026-08-15',
         updated_at = now()
   WHERE id IN (1300, 1301, 1358, 1359, 1378)
     AND start_date = DATE '2026-08-01'
     AND end_date   = DATE '2026-08-31';

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> expected THEN
    RAISE EXCEPTION 'Обновлено % строк вместо % — откат', affected, expected;
  END IF;
END $$;

COMMIT;

-- Откат:
-- UPDATE timesheet_approvals a
--    SET end_date = b.end_date, updated_at = now()
--   FROM migration_251_backup b
--  WHERE b.id = a.id;
