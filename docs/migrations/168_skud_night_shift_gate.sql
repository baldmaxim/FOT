-- 168_skud_night_shift_gate.sql
--
-- Schedule-aware гейт окна смены в recalculate_skud_daily_summary.
--
-- Баг (реальный кейс — Улмасов Б.Б., emp 1836, 15.05.2026):
--   ДНЕВНОЙ работник (график 6+0, 07:00–19:00). Последнее событие дня — фантомный
--   повторный вход 18:28:58 (через 84 сек после выхода 18:27:34), не закрытый в тот же
--   день. Окно +32ч ловит выход СЛЕДУЮЩЕГО утра 07:08:36, пара 18:28→07:08 ≈ 12.6ч
--   прибавляется к дню → total_hours = 20.75ч (вместо реальных ≈8ч).
--   Масштаб на проде: ~4737 дней (last_exit < first_entry AND total_hours > 14), 644 чел.;
--   из них ~287 — ЗАКОННЫЕ ночные смены (трогать нельзя).
--
-- Политика: пара вход→выход может пересекать полночь ТОЛЬКО если у сотрудника на эту дату
-- НОЧНАЯ смена по графику (work_end <= work_start). У дневной смены окно обрезается концом
-- суток p_date — открытый вечерний вход остаётся незакрытым (orphan) и не считается.
--
-- Признак ночной смены резолвится в SQL (is_night_shift_for): на проде все графики
-- циклические (pattern_type='cycle'), day_overrides нет, ночь только в графиках, где ВСЕ
-- слоты ночные → ночность это свойство ГРАФИКА. Helper делает широкую проверку «есть ли
-- хотя бы один ночной слот», эквивалентную TS-резолву getScheduleForDate (work_end<=work_start)
-- на текущих однородных циклах.
-- TODO: при появлении СМЕШАННЫХ день+ночь циклов helper станет шире TS (день такого графика
-- посчитает ночным) — тогда нужна per-day точность (getCycleSlot/anchor) в helper.
--
-- Окно/cap +32ч/парность/same-point-reset (161/163)/NULL/идемпотентность — без изменений.
-- batch_recalculate_skud_daily_summary (119, пересчитывает D и D−1) не меняется.
-- Бэкфилл — отдельным скриптом (scripts/backfill-night-shift-gate.ts), НЕ в миграции.

BEGIN;

-- ─── 1. Helper: ночная ли смена у сотрудника на дату ────────────────────────
CREATE OR REPLACE FUNCTION public.is_night_shift_for(p_employee_id bigint, p_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE((
    SELECT
      -- (a) ночной рабочий слот в cycle_days
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(ws.cycle_days, '[]'::jsonb)) AS e
        WHERE (e->>'work_hours')::numeric > 0
          AND NULLIF(e->>'work_start', '') IS NOT NULL
          AND NULLIF(e->>'work_end', '')   IS NOT NULL
          AND (e->>'work_end')::time <= (e->>'work_start')::time
      )
      -- (b) ночной слот в day_overrides (на будущее; сейчас 0 строк)
      OR EXISTS (
        SELECT 1 FROM jsonb_each(COALESCE(ws.day_overrides, '{}'::jsonb)) AS d(k, v)
        WHERE NULLIF(v->>'work_start', '') IS NOT NULL
          AND NULLIF(v->>'work_end', '')   IS NOT NULL
          AND (v->>'work_end')::time <= (v->>'work_start')::time
      )
      -- (c) legacy верхний уровень (не cycle): work_end <= work_start
      OR (ws.cycle_days IS NULL
          AND ws.work_start IS NOT NULL AND ws.work_end IS NOT NULL
          AND ws.work_end <= ws.work_start)
    FROM employee_schedule_assignments a
    JOIN work_schedules ws ON ws.id = a.schedule_id
    WHERE a.employee_id = p_employee_id
      AND a.effective_from <= p_date
      AND (a.effective_to IS NULL OR a.effective_to >= p_date)
    ORDER BY a.effective_from DESC
    LIMIT 1
  ), false);
$function$;

COMMENT ON FUNCTION public.is_night_shift_for(bigint, date) IS
  'true, если у сотрудника на дату назначена ночная смена (work_end<=work_start в cycle_days/day_overrides/верхнем уровне графика). Используется гейтом окна в recalculate_skud_daily_summary.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT EXECUTE ON FUNCTION public.is_night_shift_for(bigint, date) TO authenticated;
    END IF;
END;
$$;

-- ─── 2. recalc с ночным гейтом (тело 1:1 из 163 + блок гейта) ───────────────
CREATE OR REPLACE FUNCTION public.recalculate_skud_daily_summary(p_organization_id uuid, p_employee_id bigint, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_first_entry_at  TIMESTAMP;
    v_window_end      TIMESTAMP;
    v_last_exit_at    TIMESTAMP;
    v_total_seconds   DECIMAL := 0;
    v_break_seconds   DECIMAL := 0;
    v_total_hours     DECIMAL(5,2);
    v_break_hours     DECIMAL(5,2);
    v_total_minutes   INTEGER;
    v_break_minutes   INTEGER;
    v_open_entry_at    TIMESTAMP := NULL;  -- открытый вход текущей (ещё не закрытой) пары
    v_open_entry_point TEXT      := NULL;  -- точка доступа открытого входа (для same-point reset)
    v_last_pair_exit  TIMESTAMP := NULL;   -- exit последней ЗАКРЫТОЙ пары
    v_prev_pair_exit  TIMESTAMP := NULL;   -- exit ПРЕДЫДУЩЕЙ закрытой пары (для break-гэпа)
    v_work_seconds    DECIMAL := 0;        -- Σ длительностей закрытых пар
    v_is_night        BOOLEAN := false;    -- ночная ли смена (гейт окна, миграция 168)
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

    -- 2b. Ночной гейт (миграция 168): пара может пересекать полночь только у НОЧНОЙ смены.
    --     У дневной смены окно обрезается концом суток p_date — фантомный вечерний вход,
    --     закрывающийся выходом следующего утра, остаётся незакрытым (orphan) и не считается.
    v_is_night := public.is_night_shift_for(p_employee_id, p_date);
    IF NOT v_is_night THEN
        v_window_end := LEAST(
            v_window_end,
            date_trunc('day', v_first_entry_at) + INTERVAL '1 day'
        );
    END IF;

    -- 3. Один проход: собираем ТОЛЬКО закрытые пары entry→exit.
    --    entry по ТОЙ ЖЕ точке, что и открытый → открытый вход затирается (последний
    --      пробив турникета побеждает); по ДРУГОЙ точке → открытый вход НЕ сбрасывается.
    --    exit без открытого входа → orphan, игнор.
    --    work_seconds += exit − open_entry при закрытии пары.
    --    break_seconds += open_entry − prev_pair_exit (гэп между закрытыми парами).
    FOR v_rec IN
        SELECT (e.event_date + e.event_time) AS ts, e.direction, e.access_point
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
            -- Сброс открытого входа только при совпадении точки (или если открытого нет).
            -- Вход по другой точке → открытый вход сохраняется (внешний приоритет).
            IF v_open_entry_at IS NULL
               OR v_rec.access_point IS NOT DISTINCT FROM v_open_entry_point THEN
                v_open_entry_at    := v_rec.ts;
                v_open_entry_point := v_rec.access_point;
            END IF;
        ELSIF v_rec.direction = 'exit' THEN
            IF v_open_entry_at IS NOT NULL THEN
                v_work_seconds := v_work_seconds + EXTRACT(EPOCH FROM (v_rec.ts - v_open_entry_at));
                IF v_prev_pair_exit IS NOT NULL THEN
                    v_break_seconds := v_break_seconds + EXTRACT(EPOCH FROM (v_open_entry_at - v_prev_pair_exit));
                END IF;
                v_prev_pair_exit   := v_rec.ts;
                v_last_pair_exit   := v_rec.ts;
                v_open_entry_at    := NULL;
                v_open_entry_point := NULL;
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

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Бэкфилл затронутых дней — отдельным скриптом scripts/backfill-night-shift-gate.ts
-- (узкая выборка last_exit < first_entry AND total_hours > 14, чанки, ретраи).
-- Пересчёт только УМЕНЬШАЕТ часы; затронет утверждённые табели (hours_worked считается
-- на лету из skud_daily_summary). Запускать в окно низкой нагрузки.
