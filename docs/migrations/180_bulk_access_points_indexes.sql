-- Миграция 180: индексы под массовое добавление точек доступа (страница SIGUR)
-- и чтение истории изменения точек пропуска в Мониторинге подрядчиков.
--
-- 1. Поиск связанных пропусков по sigur_employee_id одним батч-запросом
--    (WHERE sigur_employee_id = ANY($1)) при bulk-операции.
-- 2. Чтение истории события CONTRACTOR_PASS_ACCESS_POINTS_ADDED по пропуску
--    (entity_type='contractor_pass' AND entity_id=$1) без seq scan.

CREATE INDEX IF NOT EXISTS contractor_passes_sigur_employee_id_idx
  ON public.contractor_passes (sigur_employee_id)
  WHERE sigur_employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_logs_entity_idx
  ON public.audit_logs (entity_type, entity_id, created_at DESC);
