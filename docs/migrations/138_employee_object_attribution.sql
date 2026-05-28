-- 138_employee_object_attribution.sql
-- Датированная привязка УДАЛЁНЩИКА к объекту (skud_objects) для учёта часов в ФОТ.
--
-- Зачем отдельная таблица (а не employee_skud_object_access):
--   employee_skud_object_access = «видимость» сотрудника в сетке /skud-presence.
--   employee_object_attribution  = «куда отнести часы удалёнщика в табеле, когда
--   в этот день НЕТ СКУД-событий». Реальный СКУД ВСЕГДА побеждает — привязка
--   используется только как фолбэк в дни без проходов. Поэтому когда удалёнщик
--   выходит на работу и начинает пробиваться, реальный объект не маскируется.
--
-- Историчность: паттерн employee_schedule_assignments / employee_assignments —
-- effective_from / effective_to (NULL = текущая), запрет пересечений через
-- daterange &&, закрытие предыдущего периода (effective_to = новый_from - 1).
-- Один открытый период на сотрудника (single-select привязка).

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_object_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  skud_object_id uuid NOT NULL REFERENCES public.skud_objects(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  effective_to date,                 -- NULL = текущая (открытая)
  reason text,
  created_by uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_object_attribution_employee_from_unique UNIQUE (employee_id, effective_from)
);

-- Один открытый период на сотрудника (single-select привязка на «сейчас»).
CREATE UNIQUE INDEX IF NOT EXISTS employee_object_attribution_one_open_idx
  ON public.employee_object_attribution(employee_id)
  WHERE effective_to IS NULL;

-- Point-in-time выборка: WHERE employee_id=$ ORDER BY effective_from DESC.
CREATE INDEX IF NOT EXISTS employee_object_attribution_emp_from_idx
  ON public.employee_object_attribution(employee_id, effective_from DESC);

-- Запрет пересечения периодов (паттерн из 020_attendance_access_refactor.sql).
CREATE OR REPLACE FUNCTION ensure_no_overlapping_employee_object_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM employee_object_attribution existing
    WHERE existing.employee_id = NEW.employee_id
      AND (to_jsonb(existing)->>'id') IS DISTINCT FROM (to_jsonb(NEW)->>'id')
      AND daterange(existing.effective_from, COALESCE(existing.effective_to, 'infinity'::date), '[]')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'Overlapping employee_object_attribution period for employee_id=%', NEW.employee_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ensure_no_overlapping_employee_object_attribution ON public.employee_object_attribution;
CREATE TRIGGER trg_ensure_no_overlapping_employee_object_attribution
BEFORE INSERT OR UPDATE ON public.employee_object_attribution
FOR EACH ROW
EXECUTE FUNCTION ensure_no_overlapping_employee_object_attribution();

COMMIT;
