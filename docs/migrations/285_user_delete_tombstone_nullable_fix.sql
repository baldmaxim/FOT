-- 285_user_delete_tombstone_nullable_fix.sql
--
-- Правка к 284. Там все авторские колонки получили ON DELETE SET DEFAULT и
-- DEFAULT = надгробный профиль. Для колонок, допускающих NULL, это оказалось
-- вредно: код при INSERT такие колонки просто не перечисляет, и вместо NULL в
-- них стало попадать надгробие. На проде за 20 минут после 284 заявка 8671
-- (status='pending') получила reviewer_id, cancelled_by и hr_acknowledged_by =
-- надгробие, из-за чего интерфейс показывал «Согласовал/Отменил: Удалённый
-- пользователь» у нерассмотренной заявки (leave-requests.controller.ts считает
-- участников решения по наличию id).
--
-- Правило уточняется:
--   own                    -> ON DELETE CASCADE                (как в 284)
--   author, колонка NOT NULL -> ON DELETE SET DEFAULT + DEFAULT = надгробие
--       (INSERT обязан передать автора, подменить нечего — имя в UI сохраняется)
--   author, колонка NULL     -> ON DELETE SET NULL, DEFAULT снимается
--       (после удаления автора поле пустеет: «—» вместо ФИО)
--   keep_null              -> ON DELETE SET NULL               (как в 284)
--
-- Дополнительно: уже записанные надгробия в nullable-колонках возвращаются в
-- NULL. Это безопасно — реальных удалений учёток после 284 не было (в
-- audit_logs нет USER_DELETED/USER_REJECTED), поэтому все такие значения
-- пришли от DEFAULT, а не от удаления.
--
-- Идемпотентно. Применение: через runner (`scripts/deploy-server.sh migrate`).

BEGIN;

DO $$
DECLARE
  r          record;
  v_tomb     constant uuid := '00000000-0000-0000-0000-00000000dead';
  v_cleared  bigint;
  v_changed  int := 0;
  v_rows     bigint := 0;
BEGIN
  FOR r IN
    SELECT c.conname,
           n.nspname                        AS schema,
           t.relname                        AS tbl,
           a.attname                        AS col,
           fn.nspname || '.' || ft.relname  AS tgt
      FROM pg_constraint c
      JOIN pg_class t      ON t.oid = c.conrelid
      JOIN pg_namespace n  ON n.oid = t.relnamespace
      JOIN pg_class ft     ON ft.oid = c.confrelid
      JOIN pg_namespace fn ON fn.oid = ft.relnamespace
      JOIN pg_attribute a  ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid IN ('public.user_profiles'::regclass, 'app_auth.users'::regclass)
       AND array_length(c.conkey, 1) = 1
       AND c.confdeltype = 'd'      -- поставлено миграцией 284
       AND NOT a.attnotnull         -- только те, где NULL допустим
     ORDER BY t.relname, a.attname
  LOOP
    -- 1. DEFAULT убираем: именно он подменял NULL при вставке.
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT', r.schema, r.tbl, r.col);

    -- 2. Политика ссылки -> SET NULL.
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.schema, r.tbl, r.conname);
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(id) ON DELETE SET NULL',
      r.schema, r.tbl, r.conname, r.col, r.tgt);

    -- 3. Уже записанные надгробия -> NULL.
    EXECUTE format('UPDATE %I.%I SET %I = NULL WHERE %I = $1', r.schema, r.tbl, r.col, r.col)
      USING v_tomb;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;

    v_changed := v_changed + 1;
    v_rows := v_rows + v_cleared;
    IF v_cleared > 0 THEN
      RAISE NOTICE '%.% -> SET NULL, очищено строк: %', r.tbl, r.col, v_cleared;
    END IF;
  END LOOP;
  RAISE NOTICE 'колонок переведено: %, строк очищено: %', v_changed, v_rows;
END $$;

-- Страховка: у NOT NULL-колонок DEFAULT обязан остаться надгробием, иначе
-- SET DEFAULT попытается записать NULL и удаление упадёт с 23502.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s.%s', t.relname, a.attname), ', ' ORDER BY t.relname, a.attname)
    INTO v_bad
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f'
     AND c.confrelid IN ('public.user_profiles'::regclass, 'app_auth.users'::regclass)
     AND c.confdeltype = 'd'
     AND a.attnotnull
     AND COALESCE((SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
                    WHERE d.adrelid = c.conrelid AND d.adnum = a.attnum), '')
         <> '''00000000-0000-0000-0000-00000000dead''::uuid';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SET DEFAULT без надгробия в DEFAULT: %', v_bad;
  END IF;
END $$;

COMMIT;

-- Проверка (каждый запрос — 0 строк):
--   -- блокирующие политики
--   SELECT conrelid::regclass, conname FROM pg_constraint
--    WHERE contype='f' AND confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)
--      AND confdeltype IN ('a','r');
--   -- SET DEFAULT на колонке, допускающей NULL (именно это чинит 285)
--   SELECT c.conrelid::regclass, a.attname FROM pg_constraint c
--     JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
--    WHERE c.contype='f' AND c.confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)
--      AND c.confdeltype='d' AND NOT a.attnotnull;
--   -- надгробие, оставшееся в nullable-колонке (пример: заявления)
--   SELECT id FROM leave_requests
--    WHERE '00000000-0000-0000-0000-00000000dead'::uuid
--          IN (reviewer_id, cancelled_by, hr_acknowledged_by);
