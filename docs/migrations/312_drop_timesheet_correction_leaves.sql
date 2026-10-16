-- 312_drop_timesheet_correction_leaves.sql
-- Откат 311: отпуск, поставленный корректировкой табеля, больше не показывается кадрам во
-- вкладке «Заявления → Отпуска» — вкладка снова только с обычными заявлениями (код откачен
-- коммитом-откатом ae0bf299).
--
-- Удаляются таблицы 311 и частичный индекс. На проде к откату отказов кадров не было (дни из
-- табеля не удалялись), уведомлений не отправлялось; теряются только отметки «Ознакомлен».
--
-- ПРИМЕНЯТЬ ПОСЛЕ ДЕПЛОЯ ОТКАЧЕННОГО БЭКЕНДА: прежний бэкенд со сверщиком без таблиц падал бы
-- каждые 20 с, а список вкладки отдавал бы ошибку. Повторный запуск безопасен.

BEGIN;

DROP TABLE IF EXISTS public.timesheet_correction_leave_days;
DROP TABLE IF EXISTS public.timesheet_correction_leave_rejections;
DROP TABLE IF EXISTS public.timesheet_correction_leave_reconcile;
DROP INDEX IF EXISTS public.idx_attendance_adjustments_manual_leave;

COMMIT;
