-- Добавление типа заявки 'work' (выход на работу в выбранные дни, в т.ч. на выходные/праздники).
-- TimeStatus 'work' уже разрешён в attendance_adjustments как канонический рабочий статус.

BEGIN;

ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_request_type_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_request_type_check
  CHECK (request_type IN ('vacation', 'sick_leave', 'remote', 'dayoff', 'certificate', 'time_correction', 'unpaid', 'work'));

COMMIT;
