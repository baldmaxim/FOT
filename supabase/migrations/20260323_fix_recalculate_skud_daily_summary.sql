-- Fix: убрана фильтрация по department_id в NOT EXISTS,
-- т.к. настройки сохраняются с department_id корневого отдела,
-- а не отдела сотрудника. Теперь фильтрация только по organization_id,
-- как во всех остальных частях системы.

CREATE OR REPLACE FUNCTION public.recalculate_skud_daily_summary(p_organization_id uuid, p_employee_id bigint, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
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
    WHERE e.organization_id = p_organization_id
      AND e.employee_id = p_employee_id
      AND e.event_date = p_date
      AND e.direction = 'entry'
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.organization_id = p_organization_id
          AND s.access_point_name = e.access_point
          AND s.is_internal = true
      )
    ORDER BY event_time ASC
    LIMIT 1;

    SELECT event_time INTO v_last_exit
    FROM skud_events e
    WHERE e.organization_id = p_organization_id
      AND e.employee_id = p_employee_id
      AND e.event_date = p_date
      AND e.direction = 'exit'
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.organization_id = p_organization_id
          AND s.access_point_name = e.access_point
          AND s.is_internal = true
      )
    ORDER BY event_time DESC
    LIMIT 1;

    FOR v_rec IN
        SELECT event_time, direction
        FROM skud_events e
        WHERE e.organization_id = p_organization_id
          AND e.employee_id = p_employee_id
          AND e.event_date = p_date
          AND NOT EXISTS (
            SELECT 1 FROM skud_access_point_settings s
            WHERE s.organization_id = p_organization_id
              AND s.access_point_name = e.access_point
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

    INSERT INTO skud_daily_summary (organization_id, employee_id, date, first_entry, last_exit, total_hours, break_hours, is_present)
    VALUES (p_organization_id, p_employee_id, p_date, v_first_entry, v_last_exit, v_total_hours, v_break_hours, v_first_entry IS NOT NULL)
    ON CONFLICT (organization_id, employee_id, date)
    DO UPDATE SET
        first_entry = EXCLUDED.first_entry,
        last_exit = EXCLUDED.last_exit,
        total_hours = EXCLUDED.total_hours,
        break_hours = EXCLUDED.break_hours,
        is_present = EXCLUDED.is_present,
        updated_at = NOW();
END;
$function$;
