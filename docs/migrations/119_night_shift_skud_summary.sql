-- 119_night_shift_skud_summary.sql
--
-- Ночные смены в табеле считались как 0 часов.
--
-- recalculate_skud_daily_summary (см. 087) спаривала события ПО КАЛЕНДАРНОМУ
-- ДНЮ (event_date = p_date) и считала время в типе TIME (время суток). Для
-- ночной смены вход (20:00) фиксируется на дате D, выход (08:00) — на D+1,
-- поэтому внутри одних суток функция видела либо только вход, либо утренний
-- выход чужой смены и вечерний вход (08:00 < 20:00) → total_hours = NULL.
--
-- Здесь функция переписана на ПООКОННЫЙ (по смене) подсчёт с timestamp-
-- арифметикой (event_date + event_time). Окно смены дня D:
--   [первый вход в D ; начало следующей смены), но не дальше +32ч.
-- Смена «вечер D → утро D+1» засчитывается полностью и относится к дню её
-- начала D — симметрично норме (getShiftDurationHours для work_end<=work_start
-- прибавляет 24ч и кладёт 12ч на день D). Логика универсальна: для дневных смен
-- результат не меняется (плюс чинится баг-кейс «выход после полуночи»).
--
-- batch_recalculate_skud_daily_summary теперь пересчитывает для каждой пары
-- {emp,date} ещё и день date-1: утренний выход ночной смены приходит событием
-- с event_date = D+1, а строку обновлять надо у дня D (старта смены).
--
-- Идемпотентно: обе функции — CREATE OR REPLACE; бэкфилл — full-recompute.

BEGIN;

-- ─── 1. recalculate_skud_daily_summary (helper) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.recalculate_skud_daily_summary(p_organization_id uuid, p_employee_id bigint, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_first_entry_at TIMESTAMP;          -- начало смены: первый вход в p_date
    v_window_end     TIMESTAMP;          -- конец окна смены (начало следующей либо cap)
    v_last_exit_at   TIMESTAMP;          -- последний выход внутри окна
    v_total_seconds  DECIMAL := 0;
    v_break_seconds  DECIMAL := 0;
    v_total_hours    DECIMAL(5,2);
    v_break_hours    DECIMAL(5,2);
    v_total_minutes  INTEGER;
    v_break_minutes  INTEGER;
    v_prev_exit_at   TIMESTAMP := NULL;
    v_rec RECORD;
BEGIN
    -- 1. Начало смены = первый НЕвнутренний вход в календарный день p_date.
    SELECT (e.event_date + e.event_time) INTO v_first_entry_at
    FROM skud_events e
    WHERE e.employee_id = p_employee_id
      AND e.event_date = p_date
      AND e.direction = 'entry'
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.access_point_name = e.access_point
          AND s.is_internal = true
      )
    ORDER BY (e.event_date + e.event_time) ASC
    LIMIT 1;

    -- Входа в p_date нет: смена в этот день не начинается (утренний выход
    -- ночной смены принадлежит дню D-1). Пишем «пустую» строку.
    IF v_first_entry_at IS NULL THEN
        INSERT INTO skud_daily_summary
              (employee_id, date, first_entry, last_exit, total_hours, break_hours, total_minutes, break_minutes, is_present)
        VALUES (p_employee_id, p_date, NULL, NULL, NULL, 0, NULL, 0, false)
        ON CONFLICT (employee_id, date)
        DO UPDATE SET
            first_entry   = NULL,
            last_exit     = NULL,
            total_hours   = NULL,
            break_hours   = 0,
            total_minutes = NULL,
            break_minutes = 0,
            is_present    = false,
            updated_at    = NOW();
        RETURN;
    END IF;

    -- 2. Конец окна смены = начало следующей смены (ближайший НЕвнутренний вход
    --    на более позднюю календарную дату), но не дальше cap +32ч.
    SELECT MIN(e.event_date + e.event_time) INTO v_window_end
    FROM skud_events e
    WHERE e.employee_id = p_employee_id
      AND e.event_date > p_date
      AND e.event_date <= p_date + 2
      AND e.direction = 'entry'
      AND (e.event_date + e.event_time) > v_first_entry_at
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.access_point_name = e.access_point
          AND s.is_internal = true
      );

    v_window_end := LEAST(
        COALESCE(v_window_end, v_first_entry_at + INTERVAL '32 hours'),
        v_first_entry_at + INTERVAL '32 hours'
    );

    -- 3. Последний выход внутри окна (v_first_entry_at ; v_window_end).
    SELECT MAX(e.event_date + e.event_time) INTO v_last_exit_at
    FROM skud_events e
    WHERE e.employee_id = p_employee_id
      AND e.event_date >= p_date
      AND e.event_date <= p_date + 2
      AND e.direction = 'exit'
      AND (e.event_date + e.event_time) > v_first_entry_at
      AND (e.event_date + e.event_time) < v_window_end
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.access_point_name = e.access_point
          AND s.is_internal = true
      );

    -- 4. Перерывы = сумма (entry − предыдущий exit) для всех событий окна.
    FOR v_rec IN
        SELECT (e.event_date + e.event_time) AS ts, e.direction
        FROM skud_events e
        WHERE e.employee_id = p_employee_id
          AND e.event_date >= p_date
          AND e.event_date <= p_date + 2
          AND (e.event_date + e.event_time) >= v_first_entry_at
          AND (e.event_date + e.event_time) < v_window_end
          AND NOT EXISTS (
            SELECT 1 FROM skud_access_point_settings s
            WHERE s.access_point_name = e.access_point
              AND s.is_internal = true
          )
        ORDER BY (e.event_date + e.event_time) ASC
    LOOP
        IF v_rec.direction = 'entry' THEN
            IF v_prev_exit_at IS NOT NULL THEN
                v_break_seconds := v_break_seconds + EXTRACT(EPOCH FROM (v_rec.ts - v_prev_exit_at));
            END IF;
            v_prev_exit_at := NULL;
        ELSIF v_rec.direction = 'exit' THEN
            v_prev_exit_at := v_rec.ts;
        END IF;
    END LOOP;

    -- 5. Итог. Timestamp-арифметика корректна и через полночь.
    IF v_last_exit_at IS NOT NULL AND v_last_exit_at > v_first_entry_at THEN
        v_total_seconds := GREATEST(
            EXTRACT(EPOCH FROM (v_last_exit_at - v_first_entry_at)) - v_break_seconds,
            0
        );
        v_total_hours   := ROUND((v_total_seconds / 3600)::numeric, 2);
        v_break_hours   := ROUND((v_break_seconds / 3600)::numeric, 2);
        v_total_minutes := ROUND(v_total_seconds / 60)::integer;
        v_break_minutes := ROUND(v_break_seconds / 60)::integer;
    ELSE
        v_total_hours   := NULL;
        v_break_hours   := 0;
        v_total_minutes := NULL;
        v_break_minutes := 0;
    END IF;

    -- first_entry/last_exit хранятся как TIME (для отображения; ночью
    -- first_entry=20:00, last_exit=08:00). total_minutes/break_minutes пишем
    -- явно — иначе legacy-значения (бэкфилл миграции 020) останутся как 0.
    INSERT INTO skud_daily_summary
          (employee_id, date, first_entry, last_exit, total_hours, break_hours, total_minutes, break_minutes, is_present)
    VALUES (p_employee_id, p_date,
            v_first_entry_at::time, v_last_exit_at::time,
            v_total_hours, v_break_hours, v_total_minutes, v_break_minutes, true)
    ON CONFLICT (employee_id, date)
    DO UPDATE SET
        first_entry   = EXCLUDED.first_entry,
        last_exit     = EXCLUDED.last_exit,
        total_hours   = EXCLUDED.total_hours,
        break_hours   = EXCLUDED.break_hours,
        total_minutes = EXCLUDED.total_minutes,
        break_minutes = EXCLUDED.break_minutes,
        is_present    = EXCLUDED.is_present,
        updated_at    = NOW();
END;
$function$;

-- ─── 2. batch_recalculate_skud_daily_summary ────────────────────────────────
-- Для каждой пары {emp,date} пересчитываем день date И день date-1: утренний
-- выход ночной смены приходит событием с event_date = D+1, но обновить надо
-- строку дня D (старта смены). Дедупликация — через DISTINCT.
CREATE OR REPLACE FUNCTION public.batch_recalculate_skud_daily_summary(p_pairs jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rec RECORD;
BEGIN
  FOR v_rec IN
    SELECT DISTINCT emp_id, d
    FROM (
      SELECT (x->>'emp_id')::bigint AS emp_id,
             (x->>'date')::date     AS d
      FROM jsonb_array_elements(p_pairs) x
      UNION ALL
      SELECT (x->>'emp_id')::bigint,
             (x->>'date')::date - 1
      FROM jsonb_array_elements(p_pairs) x
    ) s
    WHERE emp_id IS NOT NULL
      AND d IS NOT NULL
  LOOP
    PERFORM recalculate_skud_daily_summary(NULL::uuid, v_rec.emp_id, v_rec.d);
  END LOOP;
END;
$function$;

COMMIT;

-- ─── 3. Бэкфилл ─────────────────────────────────────────────────────────────
-- Полный пересчёт skud_daily_summary за последние ~6 месяцев — чтобы починить
-- уже накопленные ночные строки (где total_hours был NULL, а total_minutes —
-- legacy-0 после бэкфилла миграции 020). Идемпотентно. Окно при необходимости
-- расширить/сузить под объём skud_events.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT employee_id, event_date
    FROM skud_events
    WHERE employee_id IS NOT NULL
      AND event_date >= (CURRENT_DATE - INTERVAL '6 months')
  LOOP
    PERFORM public.recalculate_skud_daily_summary(NULL::uuid, r.employee_id, r.event_date);
  END LOOP;
END $$;
