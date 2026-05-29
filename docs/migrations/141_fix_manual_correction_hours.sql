-- 141_fix_manual_correction_hours.sql
-- Чинит «Корректировку табеля» (manual): в табеле время не считывалось, потому что
-- статус прилетал как 'work' (а не 'manual'), а у части строк ещё и терялись часы
-- (hours_override = NULL при наличии correction_hours в исходной заявке).
--
-- Новая модель статусов корректировок:
--   work   — время считается по СКУД, hours_override = NULL (часы вручную не задаются);
--   manual — «Корректировка табеля», авторитетные явные часы из hours_override;
--   remote — полный день по графику.
--
-- source_id-формат (см. также 136_backfill_corrections_reason_from_leave_requests.sql):
--   time_correction → source_id = `${leave_requests.id}:time_correction`
--
-- Идемпотентно: повторный запуск ничего не меняет (условия по status/hours_override).
--
-- ПРЕВЬЮ перед применением (опционально):
--   SELECT
--     (SELECT count(*) FROM attendance_adjustments aa
--        JOIN leave_requests lr ON aa.source_type='leave_request'
--         AND lr.id::text = split_part(aa.source_id, ':', 1)
--       WHERE aa.source_id LIKE '%:time_correction' AND lr.request_type='time_correction'
--         AND aa.status='work' AND aa.hours_override IS NULL AND lr.correction_hours IS NOT NULL) AS lost_hours_rows,
--     (SELECT count(*) FROM attendance_adjustments
--       WHERE status='work' AND hours_override IS NOT NULL AND hours_override > 0
--         AND source_type IN ('manual','leave_request')) AS work_with_hours_rows;

BEGIN;

-- 1) time_correction: вернуть потерянные часы из заявки и пометить manual там,
--    где явно заданы часы > 0 (work+0ч — «обнулённый день» — НЕ трогаем).
UPDATE attendance_adjustments aa
   SET hours_override = lr.correction_hours,
       status = CASE WHEN lr.correction_hours > 0 THEN 'manual' ELSE aa.status END,
       updated_at = now()
  FROM leave_requests lr
 WHERE aa.source_type = 'leave_request'
   AND aa.source_id LIKE '%:time_correction'
   AND lr.id::text = split_part(aa.source_id, ':', 1)
   AND lr.request_type = 'time_correction'
   AND aa.status = 'work'
   AND aa.hours_override IS NULL
   AND lr.correction_hours IS NOT NULL;

-- 2) Корректировки руководителя со статусом 'work' и явными часами > 0 — это
--    «Корректировка табеля» (manual) по новой модели. work+0ч НЕ трогаем.
--    legacy_tender_timesheet исключён: его часы по дизайну сбрасываются refresh-ом.
UPDATE attendance_adjustments
   SET status = 'manual',
       updated_at = now()
 WHERE status = 'work'
   AND hours_override IS NOT NULL
   AND hours_override > 0
   AND source_type IN ('manual', 'leave_request');

COMMIT;
