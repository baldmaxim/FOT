-- Добавление типа заявки 'educational_leave' (учебный отпуск) в ЛК сотрудника.
-- TimeStatus 'educational_leave' уже разрешён в attendance_adjustments
-- (см. attendance_adjustments_status_check) — трогаем только leave_requests.

BEGIN;

ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_request_type_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_request_type_check
  CHECK (request_type IN ('vacation', 'sick_leave', 'remote', 'dayoff', 'certificate', 'time_correction', 'unpaid', 'work', 'educational_leave'));

COMMIT;
