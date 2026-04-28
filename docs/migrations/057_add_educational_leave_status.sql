-- Добавление статуса 'educational_leave' (Учебный отпуск)
-- к табельной CHECK-ограничке.
BEGIN;

ALTER TABLE attendance_adjustments DROP CONSTRAINT attendance_adjustments_status_check;
ALTER TABLE attendance_adjustments ADD CONSTRAINT attendance_adjustments_status_check
  CHECK (status IN ('work', 'vacation', 'dayoff', 'remote', 'unpaid', 'absent', 'sick', 'manual', 'educational_leave'));

COMMIT;
