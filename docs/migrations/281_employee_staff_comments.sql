-- 281: Комментарий к сотруднику в «Управлении кадрами» (столбец «Комментарий»).
--
-- Одна строка на сотрудника: нет строки — нет комментария (пустой комментарий = DELETE).
-- updated_at — версия для оптимистичной блокировки (PUT /employees/:id/staff-comment
-- сравнивает expected_updated_at под FOR UPDATE строки employees). Прежние значения — в audit_logs
-- (действие UPDATE_STAFF_COMMENT).
-- updated_by → user_profiles ON DELETE SET NULL: удаление профиля не удаляет комментарий.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (список сотрудников читает таблицу). Повторный запуск безопасен
-- и данные не меняет.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_staff_comments (
  employee_id integer PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  comment     text NOT NULL CHECK (length(btrim(comment)) BETWEEN 1 AND 2000),
  updated_by  uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_staff_comments IS
  'Комментарий HR к сотруднику в «Управлении кадрами»; одна строка на сотрудника; см. миграцию 281';

-- Проверка схемы: CREATE TABLE IF NOT EXISTS не сверяет уже существующую таблицу.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'employee_staff_comments'
     AND (
       (column_name = 'employee_id' AND data_type = 'integer' AND is_nullable = 'NO')
       OR (column_name = 'comment'  AND data_type = 'text' AND is_nullable = 'NO')
       OR (column_name = 'updated_by' AND data_type = 'uuid' AND is_nullable = 'YES')
       OR (column_name = 'updated_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO')
     );
  IF v_count <> 4 THEN
    RAISE EXCEPTION '281: колонки employee_staff_comments не совпадают со схемой (%/4)', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_staff_comments'::regclass
     AND c.contype = 'p'
     AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
         = ARRAY['employee_id'];
  IF v_count <> 1 THEN
    RAISE EXCEPTION '281: PK employee_staff_comments должен быть (employee_id)';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_staff_comments'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.employees'::regclass
     AND c.confdeltype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '281: нет FK employee_staff_comments.employee_id → employees ON DELETE CASCADE';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_staff_comments'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.user_profiles'::regclass
     AND c.confdeltype = 'n';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '281: нет FK employee_staff_comments.updated_by → user_profiles ON DELETE SET NULL';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.employee_staff_comments'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%length(btrim(comment))%2000%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '281: нет CHECK длины comment (1..2000 после trim)';
  END IF;
END $$;

COMMIT;
