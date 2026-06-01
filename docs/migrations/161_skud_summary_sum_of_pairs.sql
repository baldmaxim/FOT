-- 161_skud_summary_sum_of_pairs.sql
--
-- Строгая политика «только полные циклы вход→выход». Отработанное время за день =
-- СУММА длительностей закрытых пар entry→exit. Любой непарный пробив отбрасывается:
--   * вход без последующего выхода (новый вход затирает открытый) — мусор;
--   * выход без предшествующего входа (orphan-exit) — мусор.
--
-- Зачем (реальный кейс — Луис Дженс, emp 1010, 21.05.2026):
--   08:20в 08:45вых 08:50в 13:35вых 13:37в 14:07вых  <- реальная работа ~5.7ч
--   20:27:14вых (orphan) 20:27:28в 20:28:17вых        <- ночной «фантомный» пробив
--   Прежняя функция (128) брала last_exit = выход последней ЗАКРЫТОЙ пары = 20:28:17,
--   а 6-часовой провал 14:07→20:27 «съедал» orphan-exit → total 12.02ч (НЕВЕРНО).
--   Здесь: total = Σ закрытых пар ≈ 5.7ч; провал 14:07→20:27 уходит в break.
--
-- Кейс 1 (два входа подряд): 08:00в 12:00в 14:00вых → 2ч (пара 12→14; вход 08:00 отброшен).
-- Кейс 2 (два выхода подряд): 08:00в 14:00вых 18:00вых → 6ч (пара 8→14; выход 18:00 orphan).
--
-- Контракт строки skud_daily_summary:
--   first_entry = первый ФИЗИЧЕСКИЙ вход дня (опоздания/пунктуальность/absence-span);
--   last_exit   = выход последней ЗАКРЫТОЙ пары;
--   total_*     = Σ длительностей закрытых пар;
--   break_*     = Σ гэпов МЕЖДУ закрытыми парами (time-outside для расчёта обеда).
-- На чистой последовательности (вход-выход-вход-выход) total/break совпадают со 128.
--
-- Окно/cap +32ч/ночные смены/NULL-обработка/идемпотентность — без изменений.
-- Также фиксится is_skud_anomalous_day (134): два входа подряд теперь = аномалия.
-- Бэкфилл — полный пересчёт за последние 6 месяцев.

BEGIN;

CREATE OR REPLACE FUNCTION public.recalculate_skud_daily_summary(p_organization_id uuid, p_employee_id bigint, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_first_entry_at TIMESTAMP;
    v_window_end     TIMESTAMP;
    v_last_exit_at   TIMESTAMP;
    v_total_seconds  DECIMAL := 0;
    v_break_seconds  DECIMAL := 0;
    v_total_hours    DECIMAL(5,2);
    v_break_hours    DECIMAL(5,2);
    v_total_minutes  INTEGER;
    v_break_minutes  INTEGER;
    v_open_entry_at  TIMESTAMP := NULL;  -- открытый вход текущей (ещё не закрытой) пары
    v_last_pair_exit TIMESTAMP := NULL;  -- exit последней ЗАКРЫТОЙ пары
    v_prev_pair_exit TIMESTAMP := NULL;  -- exit ПРЕДЫДУЩЕЙ закрытой пары (для break-гэпа)
    v_work_seconds   DECIMAL := 0;       -- Σ длительностей закрытых пар
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

    -- Входа нет → пустая строка (контракт без изменений).
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

    -- 2. Конец окна — начало следующей смены, но не дальше +32ч.
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

    -- 3. Один проход: собираем ТОЛЬКО закрытые пары entry→exit.
    --    entry при уже открытом входе → предыдущий открытый вход ОТБРАСЫВАЕТСЯ.
    --    exit без открытого входа → orphan, игнор.
    --    work_seconds += exit − open_entry при закрытии пары.
    --    break_seconds += open_entry − prev_pair_exit (гэп между закрытыми парами).
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
            -- Новый вход затирает незакрытый предыдущий → orphan-вход отброшен.
            v_open_entry_at := v_rec.ts;
        ELSIF v_rec.direction = 'exit' THEN
            IF v_open_entry_at IS NOT NULL THEN
                v_work_seconds := v_work_seconds + EXTRACT(EPOCH FROM (v_rec.ts - v_open_entry_at));
                IF v_prev_pair_exit IS NOT NULL THEN
                    v_break_seconds := v_break_seconds + EXTRACT(EPOCH FROM (v_open_entry_at - v_prev_pair_exit));
                END IF;
                v_prev_pair_exit := v_rec.ts;
                v_last_pair_exit := v_rec.ts;
                v_open_entry_at  := NULL;
            END IF;
            -- exit без открытого входа (orphan) — игнор.
        END IF;
    END LOOP;

    v_last_exit_at  := v_last_pair_exit;
    v_total_seconds := GREATEST(v_work_seconds, 0);

    -- 4. Итог. Timestamp-арифметика корректна и через полночь.
    IF v_last_exit_at IS NOT NULL AND v_total_seconds > 0 THEN
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

-- Фикс предиката аномалии (см. 134): «два входа подряд» (вход без выхода в середине
-- последовательности) теперь детектится — раньше затирался без флага.
CREATE OR REPLACE FUNCTION public.is_skud_anomalous_day(
  p_employee_id BIGINT,
  p_date        DATE,
  p_scheduled   BOOLEAN DEFAULT true
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
    v_first_entry_at TIMESTAMP;
    v_window_end     TIMESTAMP;
    v_has_orphan_exit BOOLEAN := false;
    v_has_open_entry  BOOLEAN := false;
    v_open_entry_at   TIMESTAMP := NULL;
    v_has_summary     BOOLEAN := false;
    v_is_present      BOOLEAN := false;
    v_has_any_event   BOOLEAN := false;
    v_rec RECORD;
BEGIN
    -- 1) Ошибочные события.
    IF EXISTS (
        SELECT 1 FROM public.skud_event_failures f
         WHERE f.employee_id = p_employee_id
           AND f.event_date  = p_date
    ) THEN
        RETURN true;
    END IF;

    -- 2) Парность событий в окне [first_entry; first_entry + 32h).
    SELECT (e.event_date + e.event_time) INTO v_first_entry_at
      FROM public.skud_events e
     WHERE e.employee_id = p_employee_id
       AND e.event_date  = p_date
       AND e.direction   = 'entry'
       AND NOT EXISTS (
         SELECT 1 FROM public.skud_access_point_settings s
          WHERE s.access_point_name = e.access_point
            AND s.is_internal = true
       )
     ORDER BY (e.event_date + e.event_time) ASC
     LIMIT 1;

    IF v_first_entry_at IS NOT NULL THEN
        SELECT MIN(e.event_date + e.event_time) INTO v_window_end
          FROM public.skud_events e
         WHERE e.employee_id = p_employee_id
           AND e.event_date  > p_date
           AND e.event_date <= p_date + 2
           AND e.direction   = 'entry'
           AND (e.event_date + e.event_time) > v_first_entry_at
           AND NOT EXISTS (
             SELECT 1 FROM public.skud_access_point_settings s
              WHERE s.access_point_name = e.access_point
                AND s.is_internal = true
           );

        v_window_end := LEAST(
            COALESCE(v_window_end, v_first_entry_at + INTERVAL '32 hours'),
            v_first_entry_at + INTERVAL '32 hours'
        );

        FOR v_rec IN
            SELECT (e.event_date + e.event_time) AS ts, e.direction
              FROM public.skud_events e
             WHERE e.employee_id = p_employee_id
               AND e.event_date >= p_date
               AND e.event_date <= p_date + 2
               AND (e.event_date + e.event_time) >= v_first_entry_at
               AND (e.event_date + e.event_time) <  v_window_end
               AND NOT EXISTS (
                 SELECT 1 FROM public.skud_access_point_settings s
                  WHERE s.access_point_name = e.access_point
                    AND s.is_internal = true
               )
             ORDER BY (e.event_date + e.event_time) ASC
        LOOP
            IF v_rec.direction = 'entry' THEN
                -- Два входа подряд: предыдущий вход не закрыт выходом → аномалия.
                IF v_open_entry_at IS NOT NULL THEN
                    v_has_open_entry := true;
                END IF;
                v_open_entry_at := v_rec.ts;
            ELSIF v_rec.direction = 'exit' THEN
                IF v_open_entry_at IS NULL THEN
                    v_has_orphan_exit := true;
                ELSE
                    v_open_entry_at := NULL;
                END IF;
            END IF;
        END LOOP;

        IF v_open_entry_at IS NOT NULL THEN
            v_has_open_entry := true;
        END IF;

        IF v_has_orphan_exit OR v_has_open_entry THEN
            RETURN true;
        END IF;
    END IF;

    -- 3) Полный пропуск скана при рабочем дне по графику.
    IF p_scheduled THEN
        SELECT true, COALESCE(s.is_present, false)
          INTO v_has_summary, v_is_present
          FROM public.skud_daily_summary s
         WHERE s.employee_id = p_employee_id
           AND s.date = p_date
         LIMIT 1;

        IF v_has_summary AND NOT v_is_present THEN
            SELECT EXISTS (
              SELECT 1 FROM public.skud_events e
               WHERE e.employee_id = p_employee_id
                 AND e.event_date  = p_date
            ) INTO v_has_any_event;

            IF NOT v_has_any_event THEN
                RETURN true;
            END IF;
        END IF;
    END IF;

    RETURN false;
END;
$$;

COMMENT ON FUNCTION public.is_skud_anomalous_day(BIGINT, DATE, BOOLEAN) IS
  'Предикат «день-аномалия СКУД»: failure / orphan exit / незакрытый вход (в т.ч. два входа подряд) / при p_scheduled=true — пропуск скана в рабочий день. Используется в гарде корректировок для ролей с corrections_anomalies_only=true.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT EXECUTE ON FUNCTION public.is_skud_anomalous_day(BIGINT, DATE, BOOLEAN) TO authenticated;
    END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Бэкфилл — полный пересчёт за последние 6 месяцев. Идемпотентно.
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
