-- Объект табелирования сотрудника.
--
-- Каждому своему сотруднику (не из поддерева «Подрядные организации») ночью ставится
-- объект, где у него больше всего часов с 1-го числа месяца. Хранится в существующем
-- личном режиме 249: «Офис» = current_activity, объект = object + id. Эта миграция
-- добавляет:
--   1) ИТ в группу «Офис» (группа = объекты с 1С-адресом «Текущая деятельность»);
--   2) источник личного режима timesheet_export_set_by:
--        'auto'     — поставил ночной расчёт (его он и пересчитывает);
--        'employee' — выбрал сам сотрудник в ЛК;
--        'manager'  — поменял в табеле тот, кто ведёт табель (табельщица, руководитель);
--        NULL       — при заданном режиме: поставил админ в окне «Режим табелирования»;
--   3) нормализацию: офисный объект нигде не хранится закреплённым — только current_activity;
--   4) источник редакции 'objects' — новая revision только из-за смены объекта;
--   5) фиксации месяцев employee_timesheet_object_months: версии и выгрузки прошедшего
--      месяца берут личный режим отсюда, а не живой;
--   6) состояние ночного расчёта timesheet_object_auto_state (enabled = false: включает
--      скрипт scripts/apply-auto-timesheet-objects.ts).
--
-- Базовая фиксация — месяц ДО применения (МСК) с нынешними режимами: повторная выгрузка
-- старых месяцев не изменится после массового пересчёта.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен: baseline_month не меняется,
-- дублей нет.

BEGIN;

-- ── 0. Корень подрядчиков обязателен ────────────────────────────────────────
-- Без него базовая фиксация и ночной расчёт захватили бы подрядчиков.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM org_departments
     WHERE lower(name) = lower('подрядные организации') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Не найден корень «Подрядные организации» — миграция 288 остановлена';
  END IF;
END $$;

-- ── 1. ИТ — часть «Офиса» ───────────────────────────────────────────────────
UPDATE skud_objects
   SET alt_name = 'Текущая деятельность', updated_at = now()
 WHERE name = 'ИТ' AND alt_name IS NULL;

-- ── 2. Источник личного режима ──────────────────────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS timesheet_export_set_by text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_export_set_by_check') THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_export_set_by_check
      CHECK (timesheet_export_set_by IN ('auto', 'employee', 'manager'));
  END IF;
  -- Источник без режима бессмыслен: сброс режима обязан сбрасывать и источник.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_export_set_by_requires_mode') THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_export_set_by_requires_mode
      CHECK (timesheet_export_set_by IS NULL OR timesheet_export_mode IS NOT NULL);
  END IF;
END $$;

-- ── 3. Нормализация офисных закреплений (на момент написания — 0 строк) ─────
-- Выполняется ДО базовой фиксации: фиксация обязана видеть уже канонические режимы.
UPDATE employees
   SET timesheet_export_mode = 'current_activity',
       timesheet_export_object_id = NULL,
       updated_at = now()
 WHERE timesheet_export_mode = 'object'
   AND timesheet_export_object_id IN (
     SELECT id FROM skud_objects
      WHERE lower(btrim(coalesce(alt_name, ''))) = lower('Текущая деятельность')
   );

UPDATE org_departments
   SET timesheet_export_mode = 'current_activity',
       timesheet_export_object_id = NULL
 WHERE timesheet_export_mode = 'object'
   AND timesheet_export_object_id IN (
     SELECT id FROM skud_objects
      WHERE lower(btrim(coalesce(alt_name, ''))) = lower('Текущая деятельность')
   );

-- ── 4. Редакция «только объекты» ────────────────────────────────────────────
ALTER TABLE timesheet_versions
  DROP CONSTRAINT IF EXISTS timesheet_versions_source_check;
ALTER TABLE timesheet_versions
  ADD CONSTRAINT timesheet_versions_source_check
  CHECK (source IN ('approve', 'close', 'backfill', 'rebuild', 'objects'));

-- ── 5. Фиксации месяцев ─────────────────────────────────────────────────────
-- Строка = личный режим сотрудника на конец месяца. mode = NULL — «личного режима не
-- было»: для этого месяца действует режим отдела, даже если позже появился личный.
CREATE TABLE IF NOT EXISTS employee_timesheet_object_months (
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month       date    NOT NULL,
  mode        text    NULL,
  object_id   uuid    NULL REFERENCES skud_objects(id),
  set_by      text    NULL,
  frozen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, month),
  CONSTRAINT employee_timesheet_object_months_first_day
    CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT employee_timesheet_object_months_mode_check
    CHECK (mode IN ('current_activity', 'object', 'skud')),
  CONSTRAINT employee_timesheet_object_months_set_by_check
    CHECK (set_by IN ('auto', 'employee', 'manager')),
  CONSTRAINT employee_timesheet_object_months_consistent
    CHECK (
      (mode = 'object' AND object_id IS NOT NULL)
      OR (mode IS DISTINCT FROM 'object' AND object_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_employee_timesheet_object_months_month
  ON employee_timesheet_object_months (month);

-- ── 6. Состояние ночного расчёта ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS timesheet_object_auto_state (
  singleton             boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled               boolean NOT NULL DEFAULT false,
  baseline_month        date    NOT NULL,
  frozen_month          date    NOT NULL,
  objects_rebuilt_month date    NOT NULL,
  applied_date          date    NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── 7. Базовая фиксация ─────────────────────────────────────────────────────
-- Только при первом применении (состояния ещё нет): повтор миграции её не двигает.
WITH bm AS (
  SELECT (date_trunc('month', now() AT TIME ZONE 'Europe/Moscow') - interval '1 month')::date AS month
),
contractor AS (
  SELECT d.id
    FROM public.get_descendant_department_ids(ARRAY(
      SELECT id FROM org_departments
       WHERE lower(name) = lower('подрядные организации') AND is_active = true
    )) d
)
INSERT INTO employee_timesheet_object_months (employee_id, month, mode, object_id, set_by)
SELECT e.id,
       bm.month,
       e.timesheet_export_mode,
       CASE WHEN e.timesheet_export_mode = 'object' THEN e.timesheet_export_object_id END,
       NULL
  FROM employees e
 CROSS JOIN bm
 WHERE e.is_archived = false
   AND (e.org_department_id IS NULL OR e.org_department_id NOT IN (SELECT id FROM contractor))
   AND NOT EXISTS (SELECT 1 FROM timesheet_object_auto_state)
ON CONFLICT (employee_id, month) DO NOTHING;

INSERT INTO timesheet_object_auto_state (singleton, enabled, baseline_month, frozen_month, objects_rebuilt_month)
SELECT true, false, bm.month, bm.month, bm.month
  FROM (SELECT (date_trunc('month', now() AT TIME ZONE 'Europe/Moscow') - interval '1 month')::date AS month) bm
ON CONFLICT (singleton) DO NOTHING;

COMMIT;
