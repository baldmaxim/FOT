-- 131_leave_request_selected_dates.sql
-- Хранение дискретно выбранных дней в заявлении (Работа/Удалёнка/Выходной).
-- Для непрерывных периодов (отпуск/больничный/за свой счёт) остаётся NULL
-- и используются start_date/end_date как раньше.

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS selected_dates DATE[] NULL;

COMMENT ON COLUMN leave_requests.selected_dates IS
  'Массив дискретно выбранных дней для типов work/remote/dayoff. NULL для непрерывных периодов (vacation, sick_leave, unpaid).';
