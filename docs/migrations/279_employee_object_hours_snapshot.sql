-- 279: Снимок часов сотрудников по ВСЕМ объектам + указатель опубликованного поколения.
--
-- «Статья затрат» в «Управлении кадрами» и Excel-выгрузке для режима «СКУД» перечисляет
-- объекты с часами за 30 дней. Снимок 277 хранит только основной объект, поэтому
-- employee_object_hours_snapshot хранит весь список (строка на сотрудника и объект).
--
-- Поколения: каждая строка обеих таблиц снимка ссылается на запуск (run_id), а активный
-- снимок задаёт employee_main_object_snapshot_state.active_run_id — не «последний ok по id»:
-- при конкурирующих пересчётах порядок завершения может не совпадать с порядком запуска.
-- object_hours_ready = запуск опубликовал обе таблицы. Запуски 277 остаются false, поэтому
-- до первой пересборки приложение считает объекты на лету.
-- status 'superseded' — расчёт устарел к моменту публикации (опубликован более свежий).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен и данные не меняет.
-- После деплоя бэка: npx tsx scripts/rebuild-main-object-snapshot.ts,
-- затем проверка npx tsx scripts/check-main-object-snapshot.ts.

BEGIN;

ALTER TABLE public.employee_main_object_snapshot_runs
  ADD COLUMN IF NOT EXISTS object_hours_ready boolean NOT NULL DEFAULT false;

ALTER TABLE public.employee_main_object_snapshot_runs
  DROP CONSTRAINT IF EXISTS employee_main_object_snapshot_runs_status_check;
ALTER TABLE public.employee_main_object_snapshot_runs
  ADD CONSTRAINT employee_main_object_snapshot_runs_status_check
  CHECK (status IN ('running', 'ok', 'error', 'superseded'));

ALTER TABLE public.employee_main_object_snapshot
  ADD COLUMN IF NOT EXISTS run_id bigint NULL
  REFERENCES public.employee_main_object_snapshot_runs(id);

CREATE TABLE IF NOT EXISTS public.employee_object_hours_snapshot (
  employee_id    integer NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  skud_object_id uuid NOT NULL,
  object_name    text NOT NULL,
  hours          numeric(10, 2) NOT NULL CHECK (hours > 0),
  run_id         bigint NOT NULL REFERENCES public.employee_main_object_snapshot_runs(id),
  PRIMARY KEY (employee_id, skud_object_id)
);

CREATE INDEX IF NOT EXISTS employee_object_hours_snapshot_run_idx
  ON public.employee_object_hours_snapshot (run_id);

COMMENT ON TABLE public.employee_object_hours_snapshot IS
  'Часы сотрудника по каждому объекту за 30 дней — опубликованный ночной расчёт; см. миграцию 279';

CREATE TABLE IF NOT EXISTS public.employee_main_object_snapshot_state (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_run_id bigint NULL REFERENCES public.employee_main_object_snapshot_runs(id),
  published_at  timestamptz NULL
);

INSERT INTO public.employee_main_object_snapshot_state (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

COMMENT ON TABLE public.employee_main_object_snapshot_state IS
  'Указатель опубликованного поколения снимков 277/279 (одна строка); см. миграцию 279';

-- Проверка схемы: CREATE TABLE IF NOT EXISTS не сверяет уже существующую таблицу.
DO $$
DECLARE
  v_count integer;
BEGIN
  -- Колонки employee_object_hours_snapshot: тип и NOT NULL.
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'employee_object_hours_snapshot'
     AND is_nullable = 'NO'
     AND (
       (column_name = 'employee_id'    AND data_type = 'integer')
       OR (column_name = 'skud_object_id' AND data_type = 'uuid')
       OR (column_name = 'object_name'    AND data_type = 'text')
       OR (column_name = 'hours'          AND data_type = 'numeric' AND numeric_precision = 10 AND numeric_scale = 2)
       OR (column_name = 'run_id'         AND data_type = 'bigint')
     );
  IF v_count <> 5 THEN
    RAISE EXCEPTION '279: колонки employee_object_hours_snapshot не совпадают со схемой (%/5)', v_count;
  END IF;

  -- PK ровно (employee_id, skud_object_id).
  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_object_hours_snapshot'::regclass
     AND c.contype = 'p'
     AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
         = ARRAY['employee_id', 'skud_object_id'];
  IF v_count <> 1 THEN
    RAISE EXCEPTION '279: PK employee_object_hours_snapshot должен быть (employee_id, skud_object_id)';
  END IF;

  -- FK на employees(id) ON DELETE CASCADE и на runs(id).
  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_object_hours_snapshot'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.employees'::regclass
     AND c.confdeltype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '279: нет FK employee_object_hours_snapshot.employee_id → employees ON DELETE CASCADE';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_object_hours_snapshot'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.employee_main_object_snapshot_runs'::regclass;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '279: нет FK employee_object_hours_snapshot.run_id → employee_main_object_snapshot_runs';
  END IF;

  -- CHECK hours > 0.
  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_object_hours_snapshot'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%hours > (0)%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '279: нет CHECK (hours > 0) у employee_object_hours_snapshot';
  END IF;

  -- object_hours_ready: boolean NOT NULL DEFAULT false.
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'employee_main_object_snapshot_runs'
     AND column_name = 'object_hours_ready' AND data_type = 'boolean'
     AND is_nullable = 'NO' AND column_default = 'false';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '279: employee_main_object_snapshot_runs.object_hours_ready должен быть boolean NOT NULL DEFAULT false';
  END IF;

  -- run_id основного снимка: bigint, FK на runs.
  SELECT count(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.employee_main_object_snapshot'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.employee_main_object_snapshot_runs'::regclass
     AND a.attname = 'run_id';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '279: нет FK employee_main_object_snapshot.run_id → employee_main_object_snapshot_runs';
  END IF;

  -- state: PK singleton + CHECK (singleton), FK active_run_id, ровно одна строка.
  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_main_object_snapshot_state'::regclass
     AND ((c.contype = 'p' AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (singleton)')
       OR (c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%singleton%')
       OR (c.contype = 'f' AND c.confrelid = 'public.employee_main_object_snapshot_runs'::regclass));
  IF v_count <> 3 THEN
    RAISE EXCEPTION '279: ограничения employee_main_object_snapshot_state не совпадают со схемой (%/3)', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.employee_main_object_snapshot_state;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '279: в employee_main_object_snapshot_state должна быть ровно одна строка (%)', v_count;
  END IF;

  -- Статусы журнала включают superseded.
  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_main_object_snapshot_runs'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%superseded%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '279: CHECK статусов журнала не содержит superseded';
  END IF;
END $$;

COMMIT;
