-- 216: частичный индекс для фонового поллера pending-проверок newdb.
--
-- Поллер (newdb-pending-poller.service.ts) раз в минуту выбирает глобально:
--   SELECT ... FROM newdb_checks
--    WHERE status = 'pending' AND check_type IN ('rkl','patent_msk')
--    ORDER BY created_at ASC LIMIT 15;
-- Существующий индекс начинается с contractor_pass_id и этому запросу не
-- помогает. Частичный индекс крошечный (только живые pending-строки).
--
-- Применение (вручную, как обычно): psql -f 216_newdb_checks_pending_idx.sql
-- Порядок относительно деплоя кода неважен: без индекса запрос лишь медленнее.

CREATE INDEX IF NOT EXISTS newdb_checks_pending_created_idx
  ON public.newdb_checks (created_at)
  WHERE status = 'pending'
    AND check_type IN ('rkl', 'patent_msk');
