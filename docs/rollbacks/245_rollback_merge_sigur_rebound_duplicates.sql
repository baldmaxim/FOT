-- ============================================================================
-- Откат ручной правки 245 (слияние дублей от смены карточки Sigur)
-- ============================================================================
--
-- Возвращает состояние по снимкам из public.migration_245_backup и журналу моста
-- public.migration_245_bridge_log.
--
-- ПОРЯДОК ОБЯЗАТЕЛЕН (иначе FK не даст вернуть строки ещё не существующему дублю):
--   1) снять мост: триггеры, функции, восстановить штатную batch_recalculate;
--   2) вернуть основному профилю сохранённые поля — это освобождает новый Sigur ID;
--   3) воссоздать дубль из снимка new_employee;
--   4) вернуть дублю его строки: снимок moved_events + весь post-commit хвост из
--      журнала моста (события и failure-записи);
--   5) вернуть событие увольнения из снимка;
--   6) доступы: снести текущее состояние обоих профилей, вернуть снимок;
--   7) сводка: снести пересчитанное, вернуть снимок, пересчитать даты из журнала
--      для ОБОИХ профилей.
--
-- Бэкенд на время отката должен быть остановлен: мост снимается первым шагом, и
-- работающий поллинг снова начал бы писать проходы на canonical-профиль.
--
-- ЗАПУСК:
--   предпросмотр (по умолчанию, завершается ROLLBACK):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 245_rollback_merge_sigur_rebound_duplicates.sql
--   применение:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v apply=on -f 245_rollback_merge_sigur_rebound_duplicates.sql
--
-- Каждый шаг сверяет число затронутых строк со снимками и падает с EXCEPTION.
-- После успешного отката служебные таблицы можно удалить:
--   DROP TABLE public.migration_245_backup, public.migration_245_bridge_log, public.migration_245_bridge_map;
-- ============================================================================

\if :{?apply}
\else
\set apply off
\endif

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ─── 1. Снять мост ───

DROP TRIGGER IF EXISTS migration_245_redirect ON skud_events;
DROP TRIGGER IF EXISTS migration_245_redirect ON skud_event_failures;
DROP TRIGGER IF EXISTS migration_245_journal_ins ON skud_events;
DROP TRIGGER IF EXISTS migration_245_journal_ins ON skud_event_failures;
DROP TRIGGER IF EXISTS migration_245_journal_upd ON skud_events;
DROP FUNCTION IF EXISTS public.migration_245_bridge_redirect();
DROP FUNCTION IF EXISTS public.migration_245_bridge_journal();

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT row_data->>'definition' INTO v_def
    FROM public.migration_245_backup
   WHERE migration_name = '245' AND kind = 'batch_function';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ОТКАТ 245: снимок штатной batch_recalculate_skud_daily_summary не найден';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'ОТКАТ 245: мост снят, штатная batch_recalculate восстановлена';
END $$;

-- ─── 2–7. Восстановление данных ───

DO $$
DECLARE
  c_migration CONSTANT text := '245';

  v_pairs      int;
  v_cnt        bigint;
  v_expected   bigint;
  v_bad        text := NULL;
  v_dates      date[];
  r            record;
BEGIN
  SELECT count(*) INTO v_pairs FROM public.migration_245_backup
   WHERE migration_name = c_migration AND kind = 'old_employee';
  IF v_pairs = 0 THEN
    RAISE EXCEPTION 'ОТКАТ 245: в migration_245_backup нет снимков — откатывать нечего';
  END IF;

  -- Каждая пара должна иметь все шесть видов снимков.
  SELECT count(*) INTO v_cnt FROM (
    SELECT pair_old_id, pair_new_id
      FROM public.migration_245_backup
     WHERE migration_name = c_migration
       AND kind IN ('old_employee', 'new_employee', 'dismissal_event', 'moved_events', 'access', 'summary')
     GROUP BY pair_old_id, pair_new_id
    HAVING count(DISTINCT kind) <> 6
  ) x;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'ОТКАТ 245: у % пар(ы) снимки неполные', v_cnt;
  END IF;

  -- 2. Основной профиль: возврат полей, в т.ч. прежнего Sigur ID (освобождает новый).
  UPDATE employees e
     SET sigur_employee_id            = (b.row_data->>'sigur_employee_id')::int,
         org_department_id            = (b.row_data->>'org_department_id')::uuid,
         position_id                  = (b.row_data->>'position_id')::uuid,
         employment_status            =  b.row_data->>'employment_status',
         dismissal_date               = (b.row_data->>'dismissal_date')::date,
         dismissal_apply_started_at   = (b.row_data->>'dismissal_apply_started_at')::timestamptz,
         excluded_from_timesheet      = (b.row_data->>'excluded_from_timesheet')::boolean,
         excluded_from_timesheet_date = (b.row_data->>'excluded_from_timesheet_date')::date,
         excluded_from_timesheet_at   = (b.row_data->>'excluded_from_timesheet_at')::timestamptz,
         updated_at                   = (b.row_data->>'updated_at')::timestamptz
    FROM public.migration_245_backup b
   WHERE b.migration_name = c_migration AND b.kind = 'old_employee' AND e.id = b.pair_old_id;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> v_pairs THEN
    RAISE EXCEPTION 'ОТКАТ 245: обновлено % основных профилей, ожидалось %', v_cnt, v_pairs;
  END IF;

  -- 3. Дубли (после освобождения Sigur ID).
  INSERT INTO employees
  SELECT (jsonb_populate_record(NULL::employees, row_data)).*
    FROM public.migration_245_backup
   WHERE migration_name = c_migration AND kind = 'new_employee';
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> v_pairs THEN
    RAISE EXCEPTION 'ОТКАТ 245: вставлено % дублей, ожидалось %', v_cnt, v_pairs;
  END IF;

  -- 4a. Проходы из снимка moved_events (skud_events.id — bigint, ключ партиции — (id, event_date)).
  SELECT count(*) INTO v_expected
    FROM public.migration_245_backup b, LATERAL jsonb_array_elements(b.row_data) ev
   WHERE b.migration_name = c_migration AND b.kind = 'moved_events';

  UPDATE skud_events s SET employee_id = b.pair_new_id
    FROM public.migration_245_backup b, LATERAL jsonb_array_elements(b.row_data) ev
   WHERE b.migration_name = c_migration AND b.kind = 'moved_events'
     AND s.id = (ev->>'id')::bigint AND s.event_date = (ev->>'event_date')::date;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> v_expected THEN
    RAISE EXCEPTION 'ОТКАТ 245: возвращено % проходов из снимка, ожидалось %', v_cnt, v_expected;
  END IF;

  -- 4b. Post-commit хвост из журнала моста: всё, что прилетело на canonical-профиль
  -- после слияния, без слияния попало бы на дубль — возвращаем туда же.
  UPDATE skud_events s SET employee_id = b.pair_new_id
    FROM public.migration_245_bridge_log g
    JOIN public.migration_245_backup b
      ON b.migration_name = c_migration AND b.kind = 'old_employee' AND b.pair_old_id = g.target_id
   WHERE g.table_name = 'skud_events'
     AND s.id = g.row_id AND s.event_date = g.event_date
     AND s.employee_id = g.target_id;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RAISE NOTICE 'ОТКАТ 245: возвращено дублям проходов из журнала моста: %', v_cnt;

  UPDATE skud_event_failures f SET employee_id = b.pair_new_id
    FROM public.migration_245_bridge_log g
    JOIN public.migration_245_backup b
      ON b.migration_name = c_migration AND b.kind = 'old_employee' AND b.pair_old_id = g.target_id
   WHERE g.table_name = 'skud_event_failures'
     AND f.id = g.row_id
     AND f.employee_id = g.target_id;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RAISE NOTICE 'ОТКАТ 245: возвращено дублям failure-строк из журнала моста: %', v_cnt;

  -- 5. События увольнения (id — uuid).
  UPDATE employee_dismissal_events d
     SET cancelled = (b.row_data->>'cancelled')::boolean,
         reason    =  b.row_data->>'reason'
    FROM public.migration_245_backup b
   WHERE b.migration_name = c_migration AND b.kind = 'dismissal_event'
     AND d.id = (b.row_data->>'id')::uuid;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> v_pairs THEN
    RAISE EXCEPTION 'ОТКАТ 245: восстановлено % событий увольнения, ожидалось %', v_cnt, v_pairs;
  END IF;

  -- 6. Доступы: снести текущее состояние обоих профилей, вернуть снимок.
  DELETE FROM employee_department_access a
   USING public.migration_245_backup b
   WHERE b.migration_name = c_migration AND b.kind = 'access'
     AND a.employee_id IN (b.pair_old_id, b.pair_new_id);

  SELECT count(*) INTO v_expected
    FROM public.migration_245_backup b, LATERAL jsonb_array_elements(b.row_data) x
   WHERE b.migration_name = c_migration AND b.kind = 'access';

  INSERT INTO employee_department_access
  SELECT (jsonb_populate_record(NULL::employee_department_access, x)).*
    FROM public.migration_245_backup b, LATERAL jsonb_array_elements(b.row_data) x
   WHERE b.migration_name = c_migration AND b.kind = 'access';
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> v_expected THEN
    RAISE EXCEPTION 'ОТКАТ 245: восстановлено % доступов, в снимке %', v_cnt, v_expected;
  END IF;

  -- 7. Сводка: снести пересчитанное (по affected_dates основного и всё у дубля),
  --    вернуть снимок.
  DELETE FROM skud_daily_summary s
   USING public.migration_245_backup b
   WHERE b.migration_name = c_migration AND b.kind = 'summary'
     AND (s.employee_id = b.pair_new_id
          OR (s.employee_id = b.pair_old_id
              AND s.date = ANY (ARRAY(SELECT jsonb_array_elements_text(b.row_data->'affected_dates')::date))));

  SELECT count(*) INTO v_expected
    FROM public.migration_245_backup b,
         LATERAL jsonb_array_elements(COALESCE(b.row_data->'old', '[]'::jsonb) || COALESCE(b.row_data->'new', '[]'::jsonb)) x
   WHERE b.migration_name = c_migration AND b.kind = 'summary';

  INSERT INTO skud_daily_summary
  SELECT (jsonb_populate_record(NULL::skud_daily_summary, x)).*
    FROM public.migration_245_backup b,
         LATERAL jsonb_array_elements(COALESCE(b.row_data->'old', '[]'::jsonb) || COALESCE(b.row_data->'new', '[]'::jsonb)) x
   WHERE b.migration_name = c_migration AND b.kind = 'summary';
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> v_expected THEN
    RAISE EXCEPTION 'ОТКАТ 245: восстановлено % строк сводки, в снимке %', v_cnt, v_expected;
  END IF;

  -- Пересчёт дат post-commit событий для ОБОИХ профилей пары (штатной функцией,
  -- мост уже снят — подмены id не будет).
  FOR r IN
    SELECT b.pair_old_id, b.pair_new_id,
           ARRAY(SELECT DISTINCT g.event_date
                   FROM public.migration_245_bridge_log g
                  WHERE g.table_name = 'skud_events' AND g.target_id = b.pair_old_id
                    AND g.event_date IS NOT NULL) AS dates
      FROM public.migration_245_backup b
     WHERE b.migration_name = c_migration AND b.kind = 'old_employee'
  LOOP
    IF array_length(r.dates, 1) IS NOT NULL THEN
      PERFORM public.batch_recalculate_skud_daily_summary(
        (SELECT jsonb_agg(jsonb_build_object('emp_id', e.emp, 'date', d))
           FROM unnest(r.dates) AS d, (VALUES (r.pair_old_id), (r.pair_new_id)) AS e(emp))
      );
    END IF;
  END LOOP;

  -- ─── Постусловия отката ───

  FOR r IN
    SELECT b.pair_old_id, b.pair_new_id, (b.row_data->>'sigur_employee_id')::int AS old_sigur
      FROM public.migration_245_backup b
     WHERE b.migration_name = c_migration AND b.kind = 'old_employee'
  LOOP
    SELECT count(*) INTO v_cnt FROM employees WHERE id = r.pair_old_id AND sigur_employee_id = r.old_sigur;
    IF v_cnt <> 1 THEN v_bad := concat_ws('; ', v_bad, format('профиль %s не вернул sigur %s', r.pair_old_id, r.old_sigur)); END IF;
  END LOOP;

  FOR r IN
    SELECT b.pair_new_id, (b.row_data->>'sigur_employee_id')::int AS new_sigur
      FROM public.migration_245_backup b
     WHERE b.migration_name = c_migration AND b.kind = 'new_employee'
  LOOP
    SELECT count(*) INTO v_cnt FROM employees WHERE id = r.pair_new_id AND sigur_employee_id = r.new_sigur;
    IF v_cnt <> 1 THEN v_bad := concat_ws('; ', v_bad, format('дубль %s не восстановлен с sigur %s', r.pair_new_id, r.new_sigur)); END IF;
  END LOOP;

  -- Проходы из снимка снова принадлежат дублю.
  SELECT count(*) INTO v_cnt
    FROM public.migration_245_backup b, LATERAL jsonb_array_elements(b.row_data) ev
    JOIN skud_events s ON s.id = (ev->>'id')::bigint AND s.event_date = (ev->>'event_date')::date
   WHERE b.migration_name = c_migration AND b.kind = 'moved_events'
     AND s.employee_id IS DISTINCT FROM b.pair_new_id;
  IF v_cnt > 0 THEN v_bad := concat_ws('; ', v_bad, format('%s проходов из снимка принадлежат не дублю', v_cnt)); END IF;

  -- Журнальные строки тоже вернулись дублю.
  SELECT count(*) INTO v_cnt
    FROM public.migration_245_bridge_log g
    JOIN public.migration_245_backup b
      ON b.migration_name = c_migration AND b.kind = 'old_employee' AND b.pair_old_id = g.target_id
    JOIN skud_events s ON s.id = g.row_id AND s.event_date = g.event_date
   WHERE g.table_name = 'skud_events' AND s.employee_id = g.target_id;
  IF v_cnt > 0 THEN v_bad := concat_ws('; ', v_bad, format('%s журнальных проходов остались на основном профиле', v_cnt)); END IF;

  -- Мост снят полностью.
  SELECT count(*) INTO v_cnt FROM pg_trigger
   WHERE NOT tgisinternal AND tgname IN ('migration_245_redirect', 'migration_245_journal_ins', 'migration_245_journal_upd');
  IF v_cnt > 0 THEN v_bad := concat_ws('; ', v_bad, format('остались триггеры моста: %s', v_cnt)); END IF;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ОТКАТ 245: постусловия не выполнены: %', v_bad;
  END IF;

  RAISE NOTICE 'ОТКАТ 245: восстановлено пар — %', v_pairs;
END $$;

-- Диагностика внутри транзакции.
SELECT e.id, e.full_name, e.tab_number, e.sigur_employee_id, e.employment_status,
       e.dismissal_date, e.org_department_id,
       (SELECT count(*) FROM skud_events s WHERE s.employee_id = e.id) AS events
FROM employees e
WHERE e.id IN (
  SELECT pair_old_id FROM public.migration_245_backup WHERE migration_name = '245' AND kind = 'old_employee'
  UNION SELECT pair_new_id FROM public.migration_245_backup WHERE migration_name = '245' AND kind = 'old_employee'
)
ORDER BY e.id;

\if :apply
COMMIT;
\else
ROLLBACK;
\endif
