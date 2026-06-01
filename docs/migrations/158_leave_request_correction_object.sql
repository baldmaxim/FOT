-- 158_leave_request_correction_object.sql
-- Привязка корректировки табеля из ЛК (time_correction) к конкретному объекту (skud_objects).
-- Сотрудник выбирает объект при подаче; при одобрении создаётся manual_object-корректировка
-- на этот объект (а не day-level «Не определён»). Для остальных типов заявлений — NULL.

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS correction_object_id   UUID NULL,
  ADD COLUMN IF NOT EXISTS correction_object_name TEXT NULL;

COMMENT ON COLUMN leave_requests.correction_object_id IS
  'Объект (skud_objects.id), к которому привязывается корректировка табеля из ЛК. NULL для не-корректировок.';
COMMENT ON COLUMN leave_requests.correction_object_name IS
  'Снимок имени объекта на момент подачи корректировки (для отображения без JOIN).';
