-- 247_object_ks2_source.sql
-- Признак происхождения записи КС-2.
--
-- Факт месяца по приказу — сумма подписанных КС-2 (п. 3.1), поэтому «правка факта»
-- в интерфейсе заводит корректирующую запись на разницу, а не переписывает число.
-- Чтобы такую запись можно было отличить от обычного акта после перезагрузки страницы,
-- нужен постоянный признак: определять корректировку по тексту notes ненадёжно —
-- примечание пишет человек, и любая формулировка сломала бы распознавание.
--
-- Причина корректировки хранится в notes той же записи.
--
-- ТРЕБУЕТ 241_object_kpi_ks2.sql. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE public.object_ks2_entries
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- Констрейнт отдельным шагом: ADD COLUMN IF NOT EXISTS не добавит CHECK, если колонка
-- уже создана прошлым прогоном. ADD CONSTRAINT IF NOT EXISTS в PostgreSQL нет,
-- идемпотентность даёт пара DROP IF EXISTS + ADD.
ALTER TABLE public.object_ks2_entries
  DROP CONSTRAINT IF EXISTS object_ks2_entries_source_check;

ALTER TABLE public.object_ks2_entries
  ADD CONSTRAINT object_ks2_entries_source_check
  CHECK (source IN ('manual', 'fact_adjustment'));

COMMENT ON COLUMN public.object_ks2_entries.source IS
  'manual — акт заведён руками; fact_adjustment — корректировка факта месяца, причина в notes.';

COMMIT;
