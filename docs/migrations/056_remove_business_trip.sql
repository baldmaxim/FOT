-- Удаление статуса/типа 'business_trip' (Командировка) из системы.
-- Существующие записи (если бы были) переводим в 'remote' — оба статуса оплачиваемые
-- и считаются «работа не в офисе» в WORKED_STATUSES.

BEGIN;

UPDATE attendance_adjustments SET status = 'remote' WHERE status = 'business_trip';
UPDATE leave_requests SET request_type = 'remote' WHERE request_type = 'business_trip';

ALTER TABLE attendance_adjustments DROP CONSTRAINT attendance_adjustments_status_check;
ALTER TABLE attendance_adjustments ADD CONSTRAINT attendance_adjustments_status_check
  CHECK (status IN ('work', 'vacation', 'dayoff', 'remote', 'unpaid', 'absent', 'sick', 'manual'));

ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_request_type_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_request_type_check
  CHECK (request_type IN ('vacation', 'sick_leave', 'remote', 'dayoff', 'certificate', 'time_correction'));

COMMIT;
