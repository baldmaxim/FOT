-- Добавление типа заявки 'unpaid' (отпуск за свой счёт / без сохранения).
-- TimeStatus 'unpaid' уже разрешён в attendance_adjustments с миграции 056.

BEGIN;

ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_request_type_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_request_type_check
  CHECK (request_type IN ('vacation', 'sick_leave', 'remote', 'dayoff', 'certificate', 'time_correction', 'unpaid'));

COMMIT;
