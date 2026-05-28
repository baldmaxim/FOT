-- 134_backfill_corrections_reason_from_leave_requests.sql
-- Восстанавливает оригинальные комментарии пользователей в attendance_adjustments.reason,
-- которые ранее затирались служебной строкой при approve заявки (leave_requests).
--
-- source_id-формат:
--   work / vacation / sick / unpaid / remote → source_id = String(leave_requests.id)
--   time_correction                          → source_id = `${leave_requests.id}:time_correction`
--
-- Идемпотентно: после применения служебных строк не останется,
-- оригинал переносится туда, где он был не пуст, иначе reason → NULL
-- (UI отрисует прочерк, отметка об одобрении уезжает в бейдж в интерфейсе).

BEGIN;

-- 1) work / vacation / sick / unpaid / remote
UPDATE attendance_adjustments a
   SET reason = lr.reason
  FROM leave_requests lr
 WHERE a.source_type = 'leave_request'
   AND a.reason LIKE 'Approved leave request:%'
   AND lr.id::text = split_part(a.source_id, ':', 1)
   AND COALESCE(NULLIF(TRIM(lr.reason), ''), NULL) IS NOT NULL;

-- 2) time_correction с дефолтным fallback
UPDATE attendance_adjustments a
   SET reason = lr.reason
  FROM leave_requests lr
 WHERE a.source_type = 'leave_request'
   AND a.source_id LIKE '%:time_correction'
   AND a.reason = 'Approved time correction request'
   AND lr.id::text = split_part(a.source_id, ':', 1)
   AND COALESCE(NULLIF(TRIM(lr.reason), ''), NULL) IS NOT NULL;

-- 3) Очистка оставшихся служебных строк (там, где оригинал пуст)
UPDATE attendance_adjustments
   SET reason = NULL
 WHERE source_type = 'leave_request'
   AND (reason LIKE 'Approved leave request:%' OR reason = 'Approved time correction request');

COMMIT;
