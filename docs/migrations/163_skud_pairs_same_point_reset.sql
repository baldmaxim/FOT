-- 163_skud_pairs_same_point_reset.sql
--
-- Уточнение строгой политики «только полные циклы вход→выход» (миграция 161).
-- Меняется ТОЛЬКО правило сброса открытого входа при повторном входе:
--
--   161 (было): новый вход ВСЕГДА затирает открытый («последний вход побеждает»).
--   163 (стало): новый вход затирает открытый, ТОЛЬКО если он по ТОЙ ЖЕ точке доступа.
--                Вход по ДРУГОЙ точке открытый вход НЕ сбрасывает — внешний вход
--                сохраняет приоритет.
--
-- Зачем (реальный кейс — Биркина Е.Б., emp 292, 12.05.2026):
--   07:54в @«Полковая-3 3 этаж» (внешняя)
--   07:55в 08:36в 10:08в 10:22в 11:36в 16:51в @«…Дверь 2» (внутренние)
--   17:00вых @«Полковая-3 3 этаж»
--   161 при НЕразмеченной «Дверь 2» брал последний вход 16:51 → пара 16:51→17:00 = 9 мин.
--   163: входы по другой точке («Дверь 2») не сбрасывают открытый @«…3 этаж» →
--        пара 07:54→17:00 = 9ч6м. Устойчиво даже без пометки is_internal.
--
-- Поведение 161 на чистом турникете (повторы по ОДНОЙ точке) сохраняется:
--   Кейс 1: 08:00в 12:00в 14:00вых (та же точка) → 12→14 = 2ч (вход 08:00 затёрт).
--   Кейс 2: 08:00в 14:00вых 18:00вых → 8→14 = 6ч (выход 18:00 orphan).
--   Луис Дженс (чистые пары, нет подряд-входов) → ≈5.7ч (без изменений).
--
-- Контракт строки skud_daily_summary, окно/cap +32ч/ночные смены/NULL/идемпотентность —
-- без изменений. Внутренние точки (is_internal=true) по-прежнему исключаются ДО цикла:
-- правило «той же точки» — защита от НЕразмеченных внутренних входов и корректность
-- повторного пробива одного турникета.
--
-- Ограничение: устойчивость к НЕразмеченным внутренним дверям обеспечена для ВХОДОВ.
-- Если неразмеченная внутренняя дверь эмитит ещё и ВЫХОД между внешними проходами, он
-- закроет открытую пару раньше срока. Классификация is_internal остаётся основным
-- механизмом. is_skud_anomalous_day (134/161) НЕ меняется — отдельный гард корректировок.
--
-- Бэкфилл — отдельный batched job (как в 161): полный пересчёт за последние 6 месяцев
-- внутри миграции намеренно НЕ выполняется (конфликт с живыми SKUD-записями).

BEGIN;

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

-- Полный бэкфилл за последние 6 месяцев намеренно не выполняется внутри миграции:
-- на живой продовой БД он может конфликтовать с текущими SKUD-записями.
-- Для исторических дней используйте отдельный batched job в окно низкой нагрузки.
-- ВНИМАНИЕ: новое правило не уменьшает длину внешней пары → пересчёт может ТОЛЬКО
-- увеличить оплаченные часы. Затрагивает утверждённые табели — согласовать охват.
