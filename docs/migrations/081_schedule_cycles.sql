-- Migration 081: циклические графики работы (2/2, сутки/трое, ночные смены)
-- Расширяет work_schedules новым pattern_type='cycle' с произвольной длиной цикла и якорной датой.
-- Для существующих графиков (5+0/5+2/6+0/custom) поведение не меняется — новые поля NULL.
--
-- Формат cycle_days (JSONB-массив длиной cycle_length):
--   [
--     {"work_hours": 11, "work_start": "08:00", "work_end": "20:00", "lunch_minutes": 60},
--     {"work_hours": 11, "work_start": "08:00", "work_end": "20:00", "lunch_minutes": 60},
--     {"work_hours": 0},
--     {"work_hours": 0}
--   ]
-- Для нерабочего дня (work_hours=0) поля work_start/work_end/lunch_minutes можно опустить.
--
-- anchor_date — дата, с которой начинается отсчёт цикла (день 0).
-- Назначение (employee_schedule_assignments / object_schedule_assignments) может переопределить
-- anchor_date через своё поле anchor_date (NULL = использовать дефолт паттерна).

BEGIN;

-- 1) Новые поля в work_schedules
ALTER TABLE work_schedules
  ADD COLUMN IF NOT EXISTS cycle_length INT,
  ADD COLUMN IF NOT EXISTS cycle_days   JSONB,
  ADD COLUMN IF NOT EXISTS anchor_date  DATE;

-- 2) Расширение CHECK на pattern_type
ALTER TABLE work_schedules
  DROP CONSTRAINT IF EXISTS work_schedules_pattern_type_check;
ALTER TABLE work_schedules
  ADD CONSTRAINT work_schedules_pattern_type_check
  CHECK (pattern_type IN ('5+0','5+2','6+0','custom','cycle'));

-- 3) Консистентность cycle-полей: либо все NULL (не cycle), либо все заполнены
ALTER TABLE work_schedules
  DROP CONSTRAINT IF EXISTS work_schedules_cycle_consistency_check;
ALTER TABLE work_schedules
  ADD CONSTRAINT work_schedules_cycle_consistency_check
  CHECK (
    pattern_type <> 'cycle'
    OR (
      cycle_length IS NOT NULL
      AND cycle_length BETWEEN 2 AND 28
      AND cycle_days IS NOT NULL
      AND jsonb_typeof(cycle_days) = 'array'
      AND jsonb_array_length(cycle_days) = cycle_length
      AND anchor_date IS NOT NULL
    )
  );

-- 4) anchor_date на уровне назначения (опционально перебивает дефолт паттерна)
ALTER TABLE employee_schedule_assignments
  ADD COLUMN IF NOT EXISTS anchor_date DATE;

ALTER TABLE object_schedule_assignments
  ADD COLUMN IF NOT EXISTS anchor_date DATE;

COMMIT;
