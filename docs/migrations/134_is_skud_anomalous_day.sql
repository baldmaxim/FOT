-- 134_is_skud_anomalous_day.sql
--
-- Функция-предикат «день-аномалия СКУД». Используется для проверки роли с
-- corrections_anomalies_only=true (см. миграцию 132) — корректировки hours > 0
-- разрешены только в такие дни.
--
-- Аномалией считается ЛЮБОЕ из:
--   1) skud_event_failures: за день есть запись с ошибочным событием
--      (PASS_DENY, READER_ERROR и т.п.) для сотрудника.
--   2) Парность событий: в окне [first_entry; first_entry + 32h) есть либо
--      orphan exit (exit без открытого entry), либо незакрытый entry
--      (entry без последующего exit). Логика и окно — как в
--      recalculate_skud_daily_summary (миграция 128). Внутренние турникеты
--      (skud_access_point_settings.is_internal = true) игнорируются.
--   3) Полный пропуск скана: skud_daily_summary.is_present = false и нет
--      ни одного skud_events за день. Учитывается только если вызывающий
--      пометил день как рабочий по графику (p_scheduled = true) —
--      иначе выходной без СКУД считался бы аномалией.
--
-- Контракт безопасен: STABLE, SECURITY DEFINER, явный search_path.

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
  'Предикат «день-аномалия СКУД»: failure / orphan exit / open entry / при p_scheduled=true — пропуск скана в рабочий день. Используется в гарде корректировок для ролей с corrections_anomalies_only=true.';

GRANT EXECUTE ON FUNCTION public.is_skud_anomalous_day(BIGINT, DATE, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
