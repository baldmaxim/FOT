-- 069: предпраздничные дни в производственном календаре (сокращённый рабочий день -1ч).
ALTER TABLE production_calendar
  ADD COLUMN IF NOT EXISTS pre_holidays date[] NOT NULL DEFAULT '{}';
