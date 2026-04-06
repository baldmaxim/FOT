-- Добавление поддержки разного расписания по дням недели (например, сокращённая пятница)
-- day_overrides: JSONB { "5": { "work_start": "09:00:00", "work_end": "17:00:00", "work_hours": 7 } }
-- Валидация структуры — на уровне приложения (Zod)

ALTER TABLE work_schedules
  ADD COLUMN day_overrides JSONB DEFAULT NULL;
