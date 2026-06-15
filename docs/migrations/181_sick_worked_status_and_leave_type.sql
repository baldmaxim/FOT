-- Добавление статуса/типа 'sick_worked' (Работа на больничном).
-- Часы — полный день по графику (как remote/educational_leave).
-- Затрагивает табель (attendance_adjustments) и заявления (leave_requests).
BEGIN;

ALTER TABLE attendance_adjustments DROP CONSTRAINT attendance_adjustments_status_check;
ALTER TABLE attendance_adjustments ADD CONSTRAINT attendance_adjustments_status_check
  CHECK (status IN ('work', 'vacation', 'dayoff', 'remote', 'unpaid', 'absent', 'sick', 'manual', 'educational_leave', 'sick_worked'));

ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_request_type_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_request_type_check
  CHECK (request_type IN ('vacation', 'sick_leave', 'remote', 'dayoff', 'certificate', 'time_correction', 'unpaid', 'work', 'educational_leave', 'sick_worked'));

COMMIT;
