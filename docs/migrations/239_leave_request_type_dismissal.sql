-- Добавление типа заявки 'dismissal' (заявление на увольнение) в ЛК сотрудника.
-- Заявление — только документ и маршрут согласования (руководитель отдела):
-- статуса дня в табеле оно не даёт, поэтому attendance_adjustments_status_check
-- не трогаем. Фактическое увольнение (employees.dismissal_date, Sigur) по-прежнему
-- оформляет кадровик вручную.

BEGIN;

ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_request_type_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_request_type_check
  CHECK (request_type IN ('vacation', 'sick_leave', 'remote', 'dayoff', 'certificate', 'time_correction', 'unpaid', 'work', 'educational_leave', 'sick_worked', 'dismissal'));

COMMIT;
