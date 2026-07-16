-- 223: федеральный патент (check_type='patent', метод newdb foreign_patent).
--
-- 1. Индекс поллера. 216-й создал частичный индекс с перечислением типов
--    (rkl, patent_msk). Поллер теперь выбирает и 'patent', поэтому под новый
--    запрос типо-ограниченный индекс не подойдёт — пересоздаём без списка типов:
--    предикат `status='pending'` покрывает любой набор check_type, а живых
--    pending-строк всегда мало, так что индекс остаётся крошечным.
--
-- 2. Колонка patent_blank_number — полный снимок отправленных в провайдера ПД.
--    Федеральный метод шлёт номер патента И бланк; без колонки аудит был бы
--    неполным (при таймауте нечем восстановить, что именно уходило).
--
-- CHECK-constraint не трогаем: 'patent' уже разрешён миграцией 212.
-- Применение (вручную): psql "<прод-DSN>" -v ON_ERROR_STOP=1 -f 223_newdb_checks_federal_patent.sql
-- Порядок относительно деплоя кода: колонку — ДО бэка (INSERT её пишет).

BEGIN;

ALTER TABLE public.newdb_checks
  ADD COLUMN IF NOT EXISTS patent_blank_number text NULL;

DROP INDEX IF EXISTS newdb_checks_pending_created_idx;

CREATE INDEX IF NOT EXISTS newdb_checks_pending_created_idx
  ON public.newdb_checks (created_at)
  WHERE status = 'pending';

COMMIT;
