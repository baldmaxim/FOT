-- 229: Статус 'study_day' («Учебный день», УД) для корректировок табеля.
-- Часы не задаются вручную — берутся из нормы графика (ABSENCE_STATUSES_AS_WORKED),
-- в выходной = 0. В 1С отдельной буквы нет: день выгружается целыми часами нормы.
-- Заявлений такого типа нет — leave_requests не меняем.
BEGIN;

ALTER TABLE attendance_adjustments DROP CONSTRAINT attendance_adjustments_status_check;
ALTER TABLE attendance_adjustments ADD CONSTRAINT attendance_adjustments_status_check
  CHECK (status IN ('work', 'vacation', 'dayoff', 'remote', 'unpaid', 'absent', 'sick', 'manual', 'educational_leave', 'sick_worked', 'study_day'));

COMMIT;
