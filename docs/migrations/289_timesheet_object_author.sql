-- Автор объекта табелирования: кто и когда вручную поставил личный режим сотрудника.
--
-- Нужен столбцу «Изменения объекта табелирования» единого файла 1С. Подписывается только
-- правка человеком — в ЛК, в табеле или в окне «Режим табелирования». Скрипты режимов
-- журнал почти не пишут (на проде записей нет), и «человек поставил X, скрипт записал
-- тот же X» по журналу не отличить. Поэтому автор хранится рядом с режимом, а любая
-- запись режима не человеком его стирает.
--
--   1) employees.timesheet_export_set_by_user_id / timesheet_export_set_at — автор и
--      время; employee_timesheet_object_months.set_by_user_id / set_at — то же в фиксации;
--   2) CHECK: автор бывает только у объекта или «Офиса», поставленного не ночным расчётом;
--      ID — только вместе с датой. При удалении учётки ID обнуляется, дата остаётся;
--   3) триггер на employees: запись режима без новой даты (скрипт, миграция, ночной
--      расчёт, активация) автора стирает, даже если значение то же. Автора нет и у
--      «По СКУД», у сброса режима и у 'auto';
--   4) триггер на вставку фиксации: строка месяца получает автора из employees, если режим,
--      объект и источник те же, — фиксация 1-го числа бэкендом без этих колонок автора
--      не теряет;
--   5) восстановление из журнала — только при первом запуске. Автор — последняя запись
--      о правке человеком того же пути и с тем же значением, если после неё нет записи
--      скрипта. Для строк фиксации после базовой — только записи не позже frozen_at.
--
-- Режимы, объекты и источники (set_by) миграция не меняет — только новые поля автора.
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА, бэкенд — сразу за ней: правка в ЛК или табеле между ними
-- останется без автора. Повторный запуск безопасен.

BEGIN;

-- ── 0. Первый ли запуск ─────────────────────────────────────────────────────
-- Восстановление из журнала — один раз: повтор не должен вернуть автора, которого уже
-- после миграции стёр триггер (скрипт перезаписал режим тем же значением).
CREATE TEMP TABLE _m289_first_run ON COMMIT DROP AS
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'employees'
     AND column_name = 'timesheet_export_set_at'
) AS yes;

-- ── 1. Колонки ──────────────────────────────────────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS timesheet_export_set_by_user_id uuid NULL,
  ADD COLUMN IF NOT EXISTS timesheet_export_set_at timestamptz NULL;

ALTER TABLE employee_timesheet_object_months
  ADD COLUMN IF NOT EXISTS set_by_user_id uuid NULL,
  ADD COLUMN IF NOT EXISTS set_at timestamptz NULL;

-- ── 2. FK и CHECK ───────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Авторская колонка с NULL: SET NULL без DEFAULT (политика 284/285, npm run audit:user-fk).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_timesheet_export_set_by_user_fkey') THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_timesheet_export_set_by_user_fkey
      FOREIGN KEY (timesheet_export_set_by_user_id) REFERENCES public.user_profiles(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_timesheet_object_months_set_by_user_fkey') THEN
    ALTER TABLE employee_timesheet_object_months
      ADD CONSTRAINT employee_timesheet_object_months_set_by_user_fkey
      FOREIGN KEY (set_by_user_id) REFERENCES public.user_profiles(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_timesheet_export_author_check') THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_timesheet_export_author_check
      CHECK (
        (timesheet_export_set_at IS NULL
          OR (coalesce(timesheet_export_mode, '') IN ('object', 'current_activity')
              AND timesheet_export_set_by IS DISTINCT FROM 'auto'))
        AND (timesheet_export_set_by_user_id IS NULL OR timesheet_export_set_at IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_timesheet_object_months_author_check') THEN
    ALTER TABLE employee_timesheet_object_months
      ADD CONSTRAINT employee_timesheet_object_months_author_check
      CHECK (
        (set_at IS NULL
          OR (coalesce(mode, '') IN ('object', 'current_activity') AND set_by IS DISTINCT FROM 'auto'))
        AND (set_by_user_id IS NULL OR set_at IS NOT NULL)
      );
  END IF;
END $$;

-- ── 3. Триггер на employees ─────────────────────────────────────────────────
-- Человеческие пути (ЛК, табель, окно «Режим табелирования») ставят set_at = now().
-- Любая другая запись режима — скрипт, миграция, ночной расчёт, активация — дату не
-- трогает, и автор стирается, даже если значение то же.
CREATE OR REPLACE FUNCTION public.employees_timesheet_export_author_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.timesheet_export_set_at IS NOT DISTINCT FROM OLD.timesheet_export_set_at
     OR coalesce(NEW.timesheet_export_mode, '') NOT IN ('object', 'current_activity')
     OR NEW.timesheet_export_set_by IS NOT DISTINCT FROM 'auto' THEN
    NEW.timesheet_export_set_by_user_id := NULL;
    NEW.timesheet_export_set_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS employees_timesheet_export_author_guard ON employees;
CREATE TRIGGER employees_timesheet_export_author_guard
  BEFORE UPDATE OF timesheet_export_mode, timesheet_export_object_id, timesheet_export_set_by ON employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_timesheet_export_author_guard();

-- ── 4. Триггер на вставку фиксации ──────────────────────────────────────────
-- Строка месяца — снимок режима сотрудника: автор переходит вместе с ним, если режим,
-- объект и источник те же. Нет такого сотрудника или состояние другое — автора нет.
CREATE OR REPLACE FUNCTION public.employee_timesheet_object_months_author_copy()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.set_at IS NULL THEN
    SELECT e.timesheet_export_set_by_user_id, e.timesheet_export_set_at
      INTO NEW.set_by_user_id, NEW.set_at
      FROM employees e
     WHERE e.id = NEW.employee_id
       AND e.timesheet_export_mode IS NOT DISTINCT FROM NEW.mode
       AND (CASE WHEN e.timesheet_export_mode = 'object' THEN e.timesheet_export_object_id END)
           IS NOT DISTINCT FROM NEW.object_id
       AND e.timesheet_export_set_by IS NOT DISTINCT FROM NEW.set_by;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS employee_timesheet_object_months_author_copy ON employee_timesheet_object_months;
CREATE TRIGGER employee_timesheet_object_months_author_copy
  BEFORE INSERT ON employee_timesheet_object_months
  FOR EACH ROW EXECUTE FUNCTION public.employee_timesheet_object_months_author_copy();

-- ── 5. Восстановление из журнала (первый запуск) ────────────────────────────
-- Правки людьми: ЛК, табель, окно админа — одиночная и массовая. Скрипты пишут
-- entity_type = 'timesheet_export_mode' и отменяют более раннюю правку человека:
-- со списком сотрудников — для них, без списка (откат) — для всех.
CREATE TEMP TABLE _m289_human_events ON COMMIT DROP AS
SELECT a.id,
       a.action,
       a.created_at,
       a.user_id,
       a.entity_id                     AS employee_key,
       a.details->>'new_mode'          AS new_mode,
       lower(a.details->>'new_object_id') AS new_object_id
  FROM audit_logs a
 WHERE a.entity_type = 'employee'
   AND a.action IN ('TIMESHEET_OBJECT_SELF_SELECTED', 'TIMESHEET_OBJECT_MANAGER_SELECTED', 'TIMESHEET_MODE_UPDATED')
UNION ALL
SELECT a.id,
       a.action,
       a.created_at,
       a.user_id,
       x.elem->>'id',
       a.details->>'new_mode',
       lower(a.details->>'new_object_id')
  FROM audit_logs a
 CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(a.details->'affected_employees') = 'array'
        THEN a.details->'affected_employees' ELSE '[]'::jsonb END
 ) AS x(elem)
 WHERE a.entity_type = 'employee'
   AND a.action = 'TIMESHEET_MODE_BULK_UPDATED';

CREATE TEMP TABLE _m289_script_events ON COMMIT DROP AS
SELECT a.created_at,
       CASE WHEN jsonb_typeof(a.details->'employees') = 'array'
            THEN ARRAY(SELECT x->>'id' FROM jsonb_array_elements(a.details->'employees') AS x)
       END AS employee_keys
  FROM audit_logs a
 WHERE a.entity_type = 'timesheet_export_mode';

-- Текущие режимы.
WITH last_event AS (
  SELECT DISTINCT ON (employee_key) *
    FROM _m289_human_events
   ORDER BY employee_key, created_at DESC, id DESC
)
UPDATE employees e
   SET timesheet_export_set_by_user_id = (SELECT up.id FROM user_profiles up WHERE up.id = l.user_id),
       timesheet_export_set_at = l.created_at
  FROM last_event l
 WHERE (SELECT yes FROM _m289_first_run)
   AND l.employee_key = e.id::text
   AND e.timesheet_export_mode IN ('object', 'current_activity')
   AND ((e.timesheet_export_set_by = 'employee' AND l.action = 'TIMESHEET_OBJECT_SELF_SELECTED')
     OR (e.timesheet_export_set_by = 'manager' AND l.action = 'TIMESHEET_OBJECT_MANAGER_SELECTED')
     OR (e.timesheet_export_set_by IS NULL
         AND l.action IN ('TIMESHEET_MODE_UPDATED', 'TIMESHEET_MODE_BULK_UPDATED')))
   AND l.new_mode = e.timesheet_export_mode
   AND l.new_object_id IS NOT DISTINCT FROM
       (CASE WHEN e.timesheet_export_mode = 'object' THEN e.timesheet_export_object_id::text END)
   AND NOT EXISTS (
     SELECT 1 FROM _m289_script_events s
      WHERE s.created_at > l.created_at
        AND (s.employee_keys IS NULL OR e.id::text = ANY(s.employee_keys))
   );

-- Месяцы, зафиксированные после базовой до этой миграции (например, если её применили
-- после ночи на 1-е): то же, но по состоянию фиксации и записям не позже frozen_at.
WITH last_event AS (
  SELECT DISTINCT ON (f.employee_id, f.month)
         f.employee_id, f.month, h.action, h.created_at, h.user_id, h.new_mode, h.new_object_id
    FROM employee_timesheet_object_months f
    JOIN timesheet_object_auto_state st ON st.singleton
    JOIN _m289_human_events h
      ON h.employee_key = f.employee_id::text
     AND h.created_at <= f.frozen_at
   WHERE f.month > st.baseline_month
     AND f.set_at IS NULL
   ORDER BY f.employee_id, f.month, h.created_at DESC, h.id DESC
)
UPDATE employee_timesheet_object_months f
   SET set_by_user_id = (SELECT up.id FROM user_profiles up WHERE up.id = l.user_id),
       set_at = l.created_at
  FROM last_event l
 WHERE (SELECT yes FROM _m289_first_run)
   AND f.employee_id = l.employee_id
   AND f.month = l.month
   AND f.mode IN ('object', 'current_activity')
   AND ((f.set_by = 'employee' AND l.action = 'TIMESHEET_OBJECT_SELF_SELECTED')
     OR (f.set_by = 'manager' AND l.action = 'TIMESHEET_OBJECT_MANAGER_SELECTED')
     OR (f.set_by IS NULL AND l.action IN ('TIMESHEET_MODE_UPDATED', 'TIMESHEET_MODE_BULK_UPDATED')))
   AND l.new_mode = f.mode
   AND l.new_object_id IS NOT DISTINCT FROM f.object_id::text
   AND NOT EXISTS (
     SELECT 1 FROM _m289_script_events s
      WHERE s.created_at > l.created_at
        AND s.created_at <= f.frozen_at
        AND (s.employee_keys IS NULL OR f.employee_id::text = ANY(s.employee_keys))
   );

COMMIT;
