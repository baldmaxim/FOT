-- 128_skud_daily_summary_pair_based_exit.sql
--
-- В табеле «Итого за день» иногда показывает 22:55 при реальных 9:31 (кейс
-- Свинцицкая 26.05.2026: entry 07:57, exit 17:28, и **отдельный осиротевший**
-- exit 27.05 08:02 без entry). Функция recalculate_skud_daily_summary (см. 119)
-- ищет MAX(exit) в окне «первый entry дня D + 32ч». В этом окне orphan-exit
-- 27.05 08:02 побеждает реальный exit 17:28 → last_exit принимает значение из
-- следующего дня, total_minutes = 24:05, после вычета обеда ≈ 22:55.
--
-- Фикс: считаем v_last_exit_at не как MAX, а как exit ПОСЛЕДНЕЙ ЗАКРЫТОЙ ПАРЫ
-- entry-exit в окне. Orphan-exit (без предшествующего entry в окне) — мусор,
-- игнорируется. Логика ночных смен сохраняется: entry 20:00 D → exit 08:00 D+1
-- остаётся парой, потому что между ними нет нового entry.
--
-- Окно/cap/перерывы/контракт строки skud_daily_summary не меняются — правится
-- только способ выбора last_exit.
--
-- Бэкфилл — полный пересчёт за последние 6 месяцев (как в 119). Идемпотентно.

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
    v_prev_exit_at   TIMESTAMP := NULL;
    v_open_entry_at  TIMESTAMP := NULL;  -- открытая entry в текущей паре
    v_last_pair_exit TIMESTAMP := NULL;  -- exit последней ЗАКРЫТОЙ пары
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

    -- 3+4. Один проход: считаем перерывы И собираем пары entry-exit.
    -- v_last_pair_exit — exit ПОСЛЕДНЕЙ ЗАКРЫТОЙ ПАРЫ.
    -- Orphan-exit (без предшествующего entry) обновляет v_prev_exit_at для расчёта
    -- следующего перерыва, но в last_exit не попадает.
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
            v_open_entry_at := v_rec.ts;
        ELSIF v_rec.direction = 'exit' THEN
            v_prev_exit_at := v_rec.ts;
            IF v_open_entry_at IS NOT NULL THEN
                v_last_pair_exit := v_rec.ts;
                v_open_entry_at := NULL;
            END IF;
        END IF;
    END LOOP;

    v_last_exit_at := v_last_pair_exit;

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

COMMIT;

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
