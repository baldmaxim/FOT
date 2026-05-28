-- Migration 130: обязательные воскресенья в шаблонах графиков.
-- Парный счётчик к expected_saturdays_per_month (см. миграцию 008): сотрудник
-- должен отработать N произвольных непраздничных воскресений в месяц.
-- Недобор по итогам месяца считается прогулами — логика зеркальна субботе.

BEGIN;

ALTER TABLE work_schedules
  ADD COLUMN IF NOT EXISTS expected_sundays_per_month INT NOT NULL DEFAULT 0;

COMMIT;
