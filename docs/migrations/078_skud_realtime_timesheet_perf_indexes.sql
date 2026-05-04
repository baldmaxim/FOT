-- Ускоряет живые SKUD/табельные выборки:
-- - объектная детализация табеля читает события по employee_id + event_date + event_time;
-- - presence/dashboard читают сегодняшние entry/exit и последние события по дате.

CREATE INDEX IF NOT EXISTS idx_skud_events_employee_date_time
  ON skud_events(employee_id, event_date, event_time);

CREATE INDEX IF NOT EXISTS idx_skud_events_date_direction_employee_time
  ON skud_events(event_date, direction, employee_id, event_time);
