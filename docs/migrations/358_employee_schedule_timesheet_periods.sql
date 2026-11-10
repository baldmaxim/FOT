-- 358: «Режим табелирования» → сотрудник «По графику».
--
-- Отмеченному сотруднику табель в рабочие по графику дни ставит норму дня (getDayNormHours) —
-- без проходов СКУД и даже при проходах; корректировки, отпуска, больничные главнее, выходные —
-- как у всех. Период — строка таблицы: [date_from, date_to], date_to NULL — действует сейчас.
--
-- Правила записи (окно, timesheet-schedule-mode.service.ts), всё по МСК:
--   • «Добавить» — с 1-го текущего месяца, но не раньше дня после согласованной незакрытой подачи
--     с этим сотрудником (согласованное не трогается) и не раньше дня после прошлого периода;
--     если в этом месяце период закрыло увольнение — не раньше сегодняшнего дня;
--   • «Снять» — период закрывается последним днём прошлого месяца или согласованной подачи;
--     если от периода ничего не остаётся — строка удаляется.
-- Прошлые месяцы и согласованные дни поэтому не меняются: редакции 1С не пересобираются.
--
-- Увольнение (любой путь: портал, синк Sigur, скрипт) закрывает открытый период датой увольнения
-- (closed_reason = 'dismissal') — триггер на employees ниже. После восстановления отметку ставят
-- заново.
--
-- created_by / closed_by — авторские колонки с NULL: ON DELETE SET NULL без DEFAULT (политика
-- 284/285, стережёт npm run audit:user-fk).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый расчёт табеля читает таблицу, старому бэкенду она не мешает.
-- Повторный запуск безопасен и данные не меняет.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.employee_schedule_timesheet_periods (
  id            bigserial PRIMARY KEY,
  employee_id   integer NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date_from     date NOT NULL,
  date_to       date NULL,
  closed_reason text NULL,
  created_by    uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  closed_at     timestamptz NULL,
  CONSTRAINT employee_schedule_timesheet_periods_range CHECK (date_to IS NULL OR date_to >= date_from),
  CONSTRAINT employee_schedule_timesheet_periods_closed CHECK (
    (date_to IS NULL AND closed_reason IS NULL AND closed_at IS NULL AND closed_by IS NULL)
    OR (date_to IS NOT NULL AND closed_reason IN ('manual', 'dismissal') AND closed_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.employee_schedule_timesheet_periods IS
  'Периоды «По графику» из окна «Режим табелирования»: в рабочие дни графика табель = норма дня без СКУД; см. миграцию 358';

-- Один открытый период на сотрудника.
CREATE UNIQUE INDEX IF NOT EXISTS employee_schedule_timesheet_periods_open
  ON public.employee_schedule_timesheet_periods (employee_id)
  WHERE date_to IS NULL;

CREATE INDEX IF NOT EXISTS employee_schedule_timesheet_periods_employee
  ON public.employee_schedule_timesheet_periods (employee_id, date_from);

-- Проверка схемы: CREATE TABLE IF NOT EXISTS не сверяет уже существующую таблицу.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'employee_schedule_timesheet_periods'
     AND (
       (column_name = 'employee_id' AND data_type = 'integer' AND is_nullable = 'NO')
       OR (column_name = 'date_from' AND data_type = 'date' AND is_nullable = 'NO')
       OR (column_name = 'date_to' AND data_type = 'date' AND is_nullable = 'YES')
       OR (column_name = 'closed_reason' AND data_type = 'text' AND is_nullable = 'YES')
       OR (column_name = 'created_by' AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL)
       OR (column_name = 'closed_by' AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL)
     );
  IF v_count <> 6 THEN
    RAISE EXCEPTION '358: колонки employee_schedule_timesheet_periods не совпадают со схемой (%/6)', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_schedule_timesheet_periods'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.employees'::regclass
     AND c.confdeltype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '358: нет FK employee_id → employees ON DELETE CASCADE';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_schedule_timesheet_periods'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.user_profiles'::regclass
     AND c.confdeltype = 'n';
  IF v_count <> 2 THEN
    RAISE EXCEPTION '358: created_by / closed_by → user_profiles должны быть ON DELETE SET NULL (%/2)', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'employee_schedule_timesheet_periods_open'
       AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%date_to IS NULL%'
  ) THEN
    RAISE EXCEPTION '358: нет уникального индекса открытого периода';
  END IF;
END $$;

-- Увольнение закрывает открытый период датой увольнения (нет даты — сегодня по МСК). Период,
-- который начинается позже этой даты, удаляется: от него ничего не остаётся.
CREATE OR REPLACE FUNCTION public.employee_schedule_timesheet_close_on_dismissal()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cut date := COALESCE(NEW.dismissal_date, (now() AT TIME ZONE 'Europe/Moscow')::date);
BEGIN
  DELETE FROM public.employee_schedule_timesheet_periods
   WHERE employee_id = NEW.id
     AND date_to IS NULL
     AND date_from > v_cut;
  UPDATE public.employee_schedule_timesheet_periods
     SET date_to = v_cut,
         closed_reason = 'dismissal',
         closed_by = NULL,
         closed_at = now()
   WHERE employee_id = NEW.id
     AND date_to IS NULL;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS employee_schedule_timesheet_close_on_dismissal ON public.employees;
CREATE TRIGGER employee_schedule_timesheet_close_on_dismissal
  AFTER UPDATE OF employment_status ON public.employees
  FOR EACH ROW
  WHEN (NEW.employment_status = 'fired' AND OLD.employment_status IS DISTINCT FROM 'fired')
  EXECUTE FUNCTION public.employee_schedule_timesheet_close_on_dismissal();

COMMIT;
