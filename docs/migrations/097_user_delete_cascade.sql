-- 097_user_delete_cascade.sql
-- DELETE /api/admin/users/:id (deleteUser/rejectUser) падал 500 (FK 23503).
-- Главный FK user_profiles.id → app_auth.users уже ON DELETE CASCADE
-- (validate-auth-fk.ts). Дочерние FK на user_profiles(id) и app_auth.users(id)
-- с NO ACTION/RESTRICT блокировали каскад.
-- Решение (подтверждено): hard-delete с каскадом всех зависимых записей.
-- Исключения (SET NULL, не CASCADE — иначе удалятся ДРУГИЕ юзеры):
--   user_profiles.supervisor_id, user_profiles.approved_by
-- Уже-SET NULL ('n') / уже-CASCADE ('c') не трогаются (вне выборки).
-- Идемпотентно. Применять вручную:
--   psql "<DATABASE_URL>" -v ON_ERROR_STOP=1 -f docs/migrations/097_user_delete_cascade.sql

BEGIN;

-- 1a. user_profiles.supervisor_id → user_profiles(id)  SET NULL
DO $$
DECLARE v_name text;
BEGIN
  SELECT c.conname INTO v_name
  FROM pg_constraint c
  WHERE c.contype='f'
    AND c.conrelid='public.user_profiles'::regclass
    AND c.confrelid='public.user_profiles'::regclass
    AND c.conkey=(SELECT ARRAY[a.attnum] FROM pg_attribute a
                  WHERE a.attrelid='public.user_profiles'::regclass
                    AND a.attname='supervisor_id');
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_profiles DROP CONSTRAINT %I', v_name);
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_supervisor_id_fkey
      FOREIGN KEY (supervisor_id) REFERENCES public.user_profiles(id)
      ON DELETE SET NULL;
    RAISE NOTICE 'supervisor_id → SET NULL (was %)', v_name;
  END IF;
END $$;

-- 1b. user_profiles.approved_by → app_auth.users(id)  SET NULL
DO $$
DECLARE v_name text;
BEGIN
  SELECT c.conname INTO v_name
  FROM pg_constraint c
  WHERE c.contype='f'
    AND c.conrelid='public.user_profiles'::regclass
    AND c.confrelid='app_auth.users'::regclass
    AND c.conkey=(SELECT ARRAY[a.attnum] FROM pg_attribute a
                  WHERE a.attrelid='public.user_profiles'::regclass
                    AND a.attname='approved_by');
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_profiles DROP CONSTRAINT %I', v_name);
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_approved_by_fkey
      FOREIGN KEY (approved_by) REFERENCES app_auth.users(id)
      ON DELETE SET NULL;
    RAISE NOTICE 'approved_by → SET NULL (was %)', v_name;
  END IF;
END $$;

-- 2. Все блокирующие FK (NO ACTION 'a' / RESTRICT 'r') → CASCADE
DO $$
DECLARE
  r record; v_col text; v_reftbl text;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid, c.conkey[1] AS attnum,
           n.nspname AS rel_schema, t.relname AS rel_table,
           fn.nspname AS fref_schema, ft.relname AS fref_table
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class ft ON ft.oid=c.confrelid
    JOIN pg_namespace fn ON fn.oid=ft.relnamespace
    WHERE c.contype='f'
      AND c.confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)
      AND c.confdeltype IN ('a','r')
      AND array_length(c.conkey,1)=1
      AND c.conname NOT IN ('user_profiles_supervisor_id_fkey',
                            'user_profiles_approved_by_fkey')
  LOOP
    SELECT a.attname INTO v_col FROM pg_attribute a
    WHERE a.attrelid=r.conrelid AND a.attnum=r.attnum;
    v_reftbl := format('%I.%I', r.fref_schema, r.fref_table);
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',
                   r.rel_schema, r.rel_table, r.conname);
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) '
                   || 'REFERENCES %s(id) ON DELETE CASCADE',
                   r.rel_schema, r.rel_table, r.conname, v_col, v_reftbl);
    RAISE NOTICE 'CASCADE: %.% (%)', r.rel_schema, r.rel_table, r.conname;
  END LOOP;
END $$;

COMMIT;

-- Проверка (ожидается 0 строк):
--   SELECT conrelid::regclass, conname, confdeltype FROM pg_constraint
--   WHERE contype='f'
--     AND confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)
--     AND confdeltype IN ('a','r')
--     AND conname NOT IN ('user_profiles_supervisor_id_fkey',
--                         'user_profiles_approved_by_fkey');
