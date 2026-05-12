-- 089_yandex_auth_user_fks.sql
--
-- Восстановление 5 secondary FK, ссылавшихся на auth.users в боевом
-- Supabase. После миграции Supabase Auth → app_auth.users эти FK
-- стрипаются `prepare-yandex-schema.mjs` (как `fk_auth_users_alter`)
-- и теряются в post_data — без этой миграции на Yandex останется только
-- главный FK `user_profiles_id_fkey_app_auth`, который обслуживает
-- `validate-auth-fk.ts`.
--
-- См. STAGING_REHEARSAL_REPORT.md Finding 2 — таблица атрибутов FK
-- (ON DELETE / ON UPDATE / DEFERRABLE / MATCH) снята через
-- pg_get_constraintdef + pg_constraint c боевой Supabase production
-- (project gxbtsnhevhlvmlvvqqqp), не угадана.
--
-- ─── ВАЖНО: ПОРЯДОК ПРИМЕНЕНИЯ ──────────────────────────────────────────────
-- Эту миграцию НЕЛЬЗЯ применять до того, как:
--   1. public-данные восстановлены через restore-public-data.sh;
--   2. backfill app_auth.users выполнен (migrate-auth-users -- --apply);
--   3. (опционально) главный FK validated через validate-auth-fk.ts.
--
-- Причина: NOT VALID отключает проверку только для УЖЕ существующих строк;
-- новые INSERT/UPDATE проверяются. Если приложение работает на target в
-- момент применения 089, а в app_auth.users ещё нет нужной parent-строки,
-- INSERT/UPDATE упадёт с FK violation.
--
-- VALIDATE здесь НЕ выполняется. Это делает fot-server/scripts/yandex-migration/
-- validate-auth-fks.ts (orphan-check → VALIDATE → post-check convalidated).
--
-- Идемпотентно: каждый блок проверяет наличие FK в pg_constraint перед
-- добавлением, и удаляет legacy FK на auth.users перед созданием нового.

BEGIN;

-- ── 1. user_profiles.approved_by → app_auth.users(id) ────────────────────────
-- Source: ON DELETE NO ACTION, ON UPDATE NO ACTION, NOT DEFERRABLE, MATCH SIMPLE
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t  ON t.oid  = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_class ft ON ft.oid = c.confrelid
      JOIN pg_namespace fns ON fns.oid = ft.relnamespace
     WHERE c.contype = 'f'
       AND c.conname = 'user_profiles_approved_by_fkey'
       AND ns.nspname = 'public' AND t.relname = 'user_profiles'
       AND fns.nspname = 'auth'   AND ft.relname = 'users'
  ) THEN
    ALTER TABLE public.user_profiles DROP CONSTRAINT user_profiles_approved_by_fkey;
    RAISE NOTICE 'Dropped legacy FK user_profiles_approved_by_fkey → auth.users';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_profiles_approved_by_fkey'
       AND conrelid = 'public.user_profiles'::regclass
  ) THEN
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_approved_by_fkey
      FOREIGN KEY (approved_by) REFERENCES app_auth.users(id)
      NOT VALID;
    RAISE NOTICE 'Created NOT VALID FK user_profiles_approved_by_fkey → app_auth.users';
  END IF;
END $$;

-- ── 2. audit_logs.user_id → app_auth.users(id) ───────────────────────────────
-- Source: ON DELETE NO ACTION, ON UPDATE NO ACTION, NOT DEFERRABLE, MATCH SIMPLE
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t  ON t.oid  = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_class ft ON ft.oid = c.confrelid
      JOIN pg_namespace fns ON fns.oid = ft.relnamespace
     WHERE c.contype = 'f'
       AND c.conname = 'audit_logs_user_id_fkey'
       AND ns.nspname = 'public' AND t.relname = 'audit_logs'
       AND fns.nspname = 'auth'   AND ft.relname = 'users'
  ) THEN
    ALTER TABLE public.audit_logs DROP CONSTRAINT audit_logs_user_id_fkey;
    RAISE NOTICE 'Dropped legacy FK audit_logs_user_id_fkey → auth.users';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'audit_logs_user_id_fkey'
       AND conrelid = 'public.audit_logs'::regclass
  ) THEN
    ALTER TABLE public.audit_logs
      ADD CONSTRAINT audit_logs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES app_auth.users(id)
      NOT VALID;
    RAISE NOTICE 'Created NOT VALID FK audit_logs_user_id_fkey → app_auth.users';
  END IF;
END $$;

-- ── 3. employee_assignments.created_by → app_auth.users(id) ──────────────────
-- Source: ON DELETE NO ACTION, ON UPDATE NO ACTION, NOT DEFERRABLE, MATCH SIMPLE
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t  ON t.oid  = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_class ft ON ft.oid = c.confrelid
      JOIN pg_namespace fns ON fns.oid = ft.relnamespace
     WHERE c.contype = 'f'
       AND c.conname = 'employee_assignments_created_by_fkey'
       AND ns.nspname = 'public' AND t.relname = 'employee_assignments'
       AND fns.nspname = 'auth'   AND ft.relname = 'users'
  ) THEN
    ALTER TABLE public.employee_assignments DROP CONSTRAINT employee_assignments_created_by_fkey;
    RAISE NOTICE 'Dropped legacy FK employee_assignments_created_by_fkey → auth.users';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'employee_assignments_created_by_fkey'
       AND conrelid = 'public.employee_assignments'::regclass
  ) THEN
    ALTER TABLE public.employee_assignments
      ADD CONSTRAINT employee_assignments_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES app_auth.users(id)
      NOT VALID;
    RAISE NOTICE 'Created NOT VALID FK employee_assignments_created_by_fkey → app_auth.users';
  END IF;
END $$;

-- ── 4. push_subscriptions.user_id → app_auth.users(id) ───────────────────────
-- Source: ON DELETE CASCADE, ON UPDATE NO ACTION, NOT DEFERRABLE, MATCH SIMPLE
--   ⚠ единственный FK из 5 с CASCADE — удалив юзера в app_auth, его
--   push-подписки уйдут автоматически.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t  ON t.oid  = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_class ft ON ft.oid = c.confrelid
      JOIN pg_namespace fns ON fns.oid = ft.relnamespace
     WHERE c.contype = 'f'
       AND c.conname = 'fk_push_subscriptions_user'
       AND ns.nspname = 'public' AND t.relname = 'push_subscriptions'
       AND fns.nspname = 'auth'   AND ft.relname = 'users'
  ) THEN
    ALTER TABLE public.push_subscriptions DROP CONSTRAINT fk_push_subscriptions_user;
    RAISE NOTICE 'Dropped legacy FK fk_push_subscriptions_user → auth.users';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_push_subscriptions_user'
       AND conrelid = 'public.push_subscriptions'::regclass
  ) THEN
    ALTER TABLE public.push_subscriptions
      ADD CONSTRAINT fk_push_subscriptions_user
      FOREIGN KEY (user_id) REFERENCES app_auth.users(id) ON DELETE CASCADE
      NOT VALID;
    RAISE NOTICE 'Created NOT VALID FK fk_push_subscriptions_user → app_auth.users (ON DELETE CASCADE)';
  END IF;
END $$;

-- ── 5. salary_history.created_by → app_auth.users(id) ────────────────────────
-- Source: ON DELETE NO ACTION, ON UPDATE NO ACTION, NOT DEFERRABLE, MATCH SIMPLE
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t  ON t.oid  = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_class ft ON ft.oid = c.confrelid
      JOIN pg_namespace fns ON fns.oid = ft.relnamespace
     WHERE c.contype = 'f'
       AND c.conname = 'tender_salary_history_created_by_fkey'
       AND ns.nspname = 'public' AND t.relname = 'salary_history'
       AND fns.nspname = 'auth'   AND ft.relname = 'users'
  ) THEN
    ALTER TABLE public.salary_history DROP CONSTRAINT tender_salary_history_created_by_fkey;
    RAISE NOTICE 'Dropped legacy FK tender_salary_history_created_by_fkey → auth.users';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tender_salary_history_created_by_fkey'
       AND conrelid = 'public.salary_history'::regclass
  ) THEN
    ALTER TABLE public.salary_history
      ADD CONSTRAINT tender_salary_history_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES app_auth.users(id)
      NOT VALID;
    RAISE NOTICE 'Created NOT VALID FK tender_salary_history_created_by_fkey → app_auth.users';
  END IF;
END $$;

COMMIT;

-- ─── След. шаг: VALIDATE через TS-скрипт ─────────────────────────────────────
-- VALIDATE этой миграцией НЕ выполняется. Прогоните:
--
--   cd fot-server && npm run migrate:yandex:validate-auth-fks
--
-- Скрипт проверит orphans для каждой из 5 column пар (column → app_auth.users)
-- с учётом NULL-значений, и выполнит VALIDATE CONSTRAINT с post-check
-- pg_constraint.convalidated = true.
