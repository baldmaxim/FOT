-- 087_recover_runtime_functions.sql
--
-- Восстановление 4 runtime-функций (+1 helper) в схеме public, которые
-- использует бэкенд, но которые никогда не были закоммичены в
-- docs/migrations/001-086.
--
-- Тела функций НЕ выдуманы. Они выгружены напрямую из боевой Supabase
-- (project gxbtsnhevhlvmlvvqqqp "FOT", PG 17.6) через
-- pg_get_functiondef(p.oid) — 2026-05-12. См.
-- docs/yandex-postgres-migration/01_recover_runtime_functions.md для
-- procedure воспроизводства.
--
-- Идемпотентно: все 5 объявлений — CREATE OR REPLACE FUNCTION.
--
-- ─── Список ──────────────────────────────────────────────────────────────
-- 1. recalculate_skud_daily_summary(uuid, bigint, date)
--    HELPER — пересчёт skud_daily_summary для одного (employee_id, date).
--    SECURITY DEFINER. Не вызывается напрямую бэкендом, но вызывается из
--    batch_recalculate_skud_daily_summary — поэтому должен быть тут раньше
--    него по порядку apply'а.
--
-- 2. batch_recalculate_skud_daily_summary(jsonb)
--    Вызывается бэком (presence-polling, skud-backfill, skud-import x4,
--    skud-summary-reconcile, sigur-sync-events, scripts/*). Принимает
--    массив объектов и итерирует через recalculate_skud_daily_summary.
--    SECURITY DEFINER.
--
--    ⚠ Known production quirk: функция ожидает в каждом jsonb-объекте
--    `org_id` (uuid), `emp_id` (bigint), `date` (date). Бэкенд (см.
--    fot-server/src/services/presence-polling.service.ts:844) передаёт
--    объекты `{ emp_id, date }` БЕЗ org_id — в результате
--    p_organization_id поступает как NULL. Однако helper
--    recalculate_skud_daily_summary не использует p_organization_id ни
--    в WHERE, ни в INSERT — параметр фактически dead. Поведение
--    унаследовано из production «как есть»; рефакторинг сигнатуры —
--    отдельная задача, не миграционный шаг.
--
-- 3. bulk_update_employee_ids(bigint[], bigint[])
--    Бэкфилл employee_id в skud_events. Принимает два параллельных
--    bigint[]-массива одинаковой длины (event_ids, employee_ids).
--    SECURITY DEFINER.
--
-- 4. find_skud_duplicate_ids()
--    Возвращает skud_events.id дубликатов по dedup_hash (оставляя
--    MIN(id) на dedup_hash). Используется при импорте СКУД для
--    дедупликации. SECURITY INVOKER + STABLE.
--
-- 5. find_direct_conversation(uuid, uuid)
--    Возвращает conversation_id 1:1-беседы между двумя пользователями.
--    Используется в chat.service.ts. SECURITY INVOKER + STABLE.
--
-- Все 5 функций имеют SET search_path TO 'public', 'pg_catalog' (взято
-- из боевой схемы напрямую) — preflight в конце файла это проверяет.

BEGIN;

-- ─── 1. recalculate_skud_daily_summary (helper) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.recalculate_skud_daily_summary(p_organization_id uuid, p_employee_id bigint, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_first_entry TIME;
    v_last_exit TIME;
    v_total_seconds DECIMAL := 0;
    v_break_seconds DECIMAL := 0;
    v_total_hours DECIMAL(5,2);
    v_break_hours DECIMAL(5,2);
    v_prev_exit TIME := NULL;
    v_rec RECORD;
BEGIN
    SELECT event_time INTO v_first_entry
    FROM skud_events e
    WHERE e.employee_id = p_employee_id
      AND e.event_date = p_date
      AND e.direction = 'entry'
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.access_point_name = e.access_point
          AND s.is_internal = true
      )
    ORDER BY event_time ASC
    LIMIT 1;

    SELECT event_time INTO v_last_exit
    FROM skud_events e
    WHERE e.employee_id = p_employee_id
      AND e.event_date = p_date
      AND e.direction = 'exit'
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.access_point_name = e.access_point
          AND s.is_internal = true
      )
    ORDER BY event_time DESC
    LIMIT 1;

    FOR v_rec IN
        SELECT event_time, direction
        FROM skud_events e
        WHERE e.employee_id = p_employee_id
          AND e.event_date = p_date
          AND NOT EXISTS (
            SELECT 1 FROM skud_access_point_settings s
            WHERE s.access_point_name = e.access_point
              AND s.is_internal = true
          )
        ORDER BY event_time ASC
    LOOP
        IF v_rec.direction = 'entry' THEN
            IF v_prev_exit IS NOT NULL THEN
                v_break_seconds := v_break_seconds + EXTRACT(EPOCH FROM (v_rec.event_time - v_prev_exit));
            END IF;
            v_prev_exit := NULL;
        ELSIF v_rec.direction = 'exit' THEN
            v_prev_exit := v_rec.event_time;
        END IF;
    END LOOP;

    IF v_first_entry IS NOT NULL AND v_last_exit IS NOT NULL AND v_last_exit > v_first_entry THEN
        v_total_seconds := EXTRACT(EPOCH FROM (v_last_exit - v_first_entry)) - v_break_seconds;
        v_total_hours := GREATEST(v_total_seconds / 3600, 0);
        v_break_hours := v_break_seconds / 3600;
    ELSE
        v_total_hours := NULL;
        v_break_hours := 0;
    END IF;

    INSERT INTO skud_daily_summary (employee_id, date, first_entry, last_exit, total_hours, break_hours, is_present)
    VALUES (p_employee_id, p_date, v_first_entry, v_last_exit, v_total_hours, v_break_hours, v_first_entry IS NOT NULL)
    ON CONFLICT (employee_id, date)
    DO UPDATE SET
        first_entry = EXCLUDED.first_entry,
        last_exit = EXCLUDED.last_exit,
        total_hours = EXCLUDED.total_hours,
        break_hours = EXCLUDED.break_hours,
        is_present = EXCLUDED.is_present,
        updated_at = NOW();
END;
$function$;

-- ─── 2. batch_recalculate_skud_daily_summary ────────────────────────────────
CREATE OR REPLACE FUNCTION public.batch_recalculate_skud_daily_summary(p_pairs jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pair jsonb;
BEGIN
  FOR v_pair IN SELECT * FROM jsonb_array_elements(p_pairs)
  LOOP
    PERFORM recalculate_skud_daily_summary(
      (v_pair->>'org_id')::uuid,
      (v_pair->>'emp_id')::bigint,
      (v_pair->>'date')::date
    );
  END LOOP;
END;
$function$;

-- ─── 3. bulk_update_employee_ids ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bulk_update_employee_ids(p_event_ids bigint[], p_employee_ids bigint[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  UPDATE skud_events
  SET employee_id = updates.emp_id
  FROM (
    SELECT unnest(p_event_ids) AS evt_id,
           unnest(p_employee_ids) AS emp_id
  ) AS updates
  WHERE skud_events.id = updates.evt_id
    AND skud_events.employee_id IS NULL;
END;
$function$;

-- ─── 4. find_skud_duplicate_ids ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.find_skud_duplicate_ids()
 RETURNS TABLE(id bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT se.id
  FROM public.skud_events se
  INNER JOIN (
    SELECT dedup_hash, MIN(se2.id) AS keep_id
    FROM public.skud_events se2
    WHERE se2.dedup_hash IS NOT NULL
    GROUP BY se2.dedup_hash
    HAVING COUNT(*) > 1
  ) dupes ON se.dedup_hash = dupes.dedup_hash AND se.id <> dupes.keep_id;
$function$;

-- ─── 5. find_direct_conversation ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.find_direct_conversation(user1 uuid, user2 uuid)
 RETURNS TABLE(conversation_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT cp1.conversation_id
  FROM chat_participants cp1
  JOIN chat_participants cp2 ON cp1.conversation_id = cp2.conversation_id
  WHERE cp1.user_id = user1 AND cp2.user_id = user2
  AND (SELECT COUNT(*) FROM chat_participants cp3 WHERE cp3.conversation_id = cp1.conversation_id) = 2
  LIMIT 1;
$function$;

COMMIT;

-- ─── Preflight ──────────────────────────────────────────────────────────────
-- Падает с RAISE EXCEPTION, если:
--   * хоть одна функция отсутствует;
--   * в теле остался sentinel TODO_REAL_BODY_NOT_INSERTED (защита от
--     случайно вкоммиченного шаблона);
--   * тело содержит RAISE EXCEPTION 'not implemented' (placeholder stub);
--   * SECURITY DEFINER функция не имеет SET search_path в proconfig.

DO $$
DECLARE
  required text[] := ARRAY[
    'recalculate_skud_daily_summary',
    'batch_recalculate_skud_daily_summary',
    'bulk_update_employee_ids',
    'find_skud_duplicate_ids',
    'find_direct_conversation'
  ];
  fname text;
  missing text[] := ARRAY[]::text[];
  placeholders text[] := ARRAY[]::text[];
  sec_definer_no_search_path text[] := ARRAY[]::text[];
  func_oid oid;
  func_def text;
  func_secdef boolean;
  func_config text[];
  has_search_path boolean;
BEGIN
  FOREACH fname IN ARRAY required LOOP
    SELECT p.oid, p.prosecdef, p.proconfig
      INTO func_oid, func_secdef, func_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fname
     LIMIT 1;

    IF func_oid IS NULL THEN
      missing := array_append(missing, fname);
      CONTINUE;
    END IF;

    func_def := pg_get_functiondef(func_oid);

    -- (а) sentinel из шаблона
    IF func_def ILIKE '%TODO_REAL_BODY_NOT_INSERTED%' THEN
      placeholders := array_append(placeholders, fname || ' (TODO_REAL_BODY_NOT_INSERTED sentinel)');
      CONTINUE;
    END IF;

    -- (б) RAISE EXCEPTION 'not implemented' — типичный placeholder
    IF func_def ~* 'raise\s+exception\s+''not\s+implemented''' THEN
      placeholders := array_append(placeholders, fname || ' (RAISE EXCEPTION ''not implemented'')');
      CONTINUE;
    END IF;

    -- (в) SECURITY DEFINER должна иметь SET search_path
    IF func_secdef THEN
      has_search_path := false;
      IF func_config IS NOT NULL THEN
        has_search_path := EXISTS (
          SELECT 1 FROM unnest(func_config) AS cfg
           WHERE cfg ILIKE 'search_path=%'
        );
      END IF;
      IF NOT has_search_path THEN
        sec_definer_no_search_path := array_append(sec_definer_no_search_path, fname);
      END IF;
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      '087: required functions are MISSING in public: %',
      array_to_string(missing, ', ');
  END IF;

  IF array_length(placeholders, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      '087: functions still contain placeholder bodies: %',
      array_to_string(placeholders, '; ');
  END IF;

  IF array_length(sec_definer_no_search_path, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      '087: SECURITY DEFINER functions WITHOUT SET search_path: %',
      array_to_string(sec_definer_no_search_path, ', ');
  END IF;
END $$;
