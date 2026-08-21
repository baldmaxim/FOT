-- 252_object_contract_opening_remainder.sql
-- Ручной остаток по договору на первый расчётный месяц.
--
-- Остаток месяца выводится формулой «стоимость договора с ДС − накопленный КС-2», то есть
-- корректная цифра требовала завести КС-2 за КАЖДЫЙ прошедший месяц объекта. Экономисту
-- нужна только точка отсчёта, а не история актов: эта колонка её и задаёт.
--
-- Хранится именно ОСТАТОК, а не накопленный объём: при подписании нового ДС остаток обязан
-- вырасти вместе со стоимостью договора, и хранимое накопление пришлось бы пересчитывать.
-- В накопление отчёт конвертирует значение на лету:
--   opening_ks2 = base_amount + Σ ДС(signed, effective_date <= plan_start_month) − opening_remainder
--
-- NULL = «считать по КС-2, как раньше». Ноль — это полностью закрытый объект, не то же самое.
--
-- ТРЕБУЕТ 241_object_kpi_ks2.sql. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE public.object_contracts
  ADD COLUMN IF NOT EXISTS opening_remainder numeric(15,2);

-- Констрейнты отдельными шагами: ADD COLUMN IF NOT EXISTS не добавит CHECK, если колонка
-- уже создана прошлым прогоном. ADD CONSTRAINT IF NOT EXISTS в PostgreSQL нет,
-- идемпотентность даёт пара DROP IF EXISTS + ADD.
ALTER TABLE public.object_contracts
  DROP CONSTRAINT IF EXISTS object_contracts_opening_remainder_check;

ALTER TABLE public.object_contracts
  ADD CONSTRAINT object_contracts_opening_remainder_check
  CHECK (opening_remainder IS NULL OR opening_remainder >= 0);

-- Остаток без точки отсчёта бессмыслен: месяц задаёт plan_start_month.
ALTER TABLE public.object_contracts
  DROP CONSTRAINT IF EXISTS object_contracts_opening_remainder_month_check;

ALTER TABLE public.object_contracts
  ADD CONSTRAINT object_contracts_opening_remainder_month_check
  CHECK (opening_remainder IS NULL OR plan_start_month IS NOT NULL);

-- Покрывающий индекс отчёта пересоздаётся целиком: INCLUDE-список не патчится ALTER-ом.
-- Обе операции внутри той же транзакции, иначе обрыв между ними оставил бы отчёт без индекса.
DROP INDEX IF EXISTS public.object_contracts_report_idx;

CREATE INDEX object_contracts_report_idx
  ON public.object_contracts (skud_object_id)
  INCLUDE (base_amount, planned_zos_date, actual_zos_date, planned_headcount,
           plan_start_month, opening_remainder);

COMMENT ON COLUMN public.object_contracts.opening_remainder IS
  'Ручной остаток по договору на начало plan_start_month. NULL — считать по КС-2, как обычно.';

COMMIT;
