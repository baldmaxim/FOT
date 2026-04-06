-- Добавление поддержки разного расписания по дням недели (например, сокращённая пятница)
-- day_overrides: JSONB { "5": { "work_start": "09:00:00", "work_end": "17:00:00", "work_hours": 7 } }

ALTER TABLE work_schedules
  ADD COLUMN day_overrides JSONB DEFAULT NULL;

-- Ключи — только дни недели 1..7
ALTER TABLE work_schedules
  ADD CONSTRAINT chk_day_overrides CHECK (
    day_overrides IS NULL
    OR (
      jsonb_typeof(day_overrides) = 'object'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(day_overrides) AS kv
        WHERE kv.key NOT IN ('1','2','3','4','5','6','7')
      )
    )
  );
