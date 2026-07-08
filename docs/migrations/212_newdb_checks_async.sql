-- 212_newdb_checks_async.sql
-- newdb асинхронный (queued): статус 'pending' + newdb_request_id для матчинга
-- результата. Плюс новые методы патента patent_msk (Москва) / patent_mo (МО).
-- Таблица newdb_checks уже создана 211-й — пересоздаём CHECK идемпотентно.

BEGIN;

-- Расширяем check_type: rkl, patent (старые тестовые строки), patent_msk, patent_mo
ALTER TABLE public.newdb_checks DROP CONSTRAINT IF EXISTS newdb_checks_check_type_check;
ALTER TABLE public.newdb_checks
  ADD CONSTRAINT newdb_checks_check_type_check
  CHECK (check_type IN ('rkl', 'patent', 'patent_msk', 'patent_mo'));

-- Расширяем status: добавляем 'pending' (запрос принят, ждём async-результат)
ALTER TABLE public.newdb_checks DROP CONSTRAINT IF EXISTS newdb_checks_status_check;
ALTER TABLE public.newdb_checks
  ADD CONSTRAINT newdb_checks_status_check
  CHECK (status IN ('clean', 'found', 'invalid', 'error', 'not_applicable', 'pending'));

-- requestId от newdb — по нему матчим асинхронный результат queued-запроса
ALTER TABLE public.newdb_checks
  ADD COLUMN IF NOT EXISTS newdb_request_id text NULL;

COMMIT;
