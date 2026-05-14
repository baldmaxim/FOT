-- 092_employee_skud_object_access.sql
-- Приписка сотрудника к объекту строительства (skud_objects).
-- M:N связь: один сотрудник может числиться на нескольких объектах,
-- один объект — содержать многих сотрудников.
--
-- Семантика: атрибут самого сотрудника (его «прописка»/«место работы»),
-- НЕ зависит от того, через какие проходные он реально пробивается.
-- Используется на /skud-presence: для пользователя с приписками
-- сетка объектов фильтруется по его employee_id → object_ids.
-- Внутри бакета объекта по-прежнему показывается фактическое
-- присутствие (skud_events за день), а не «приписанные на смене».

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_skud_object_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  skud_object_id uuid NOT NULL REFERENCES public.skud_objects(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_skud_object_access_unique UNIQUE (employee_id, skud_object_id)
);

CREATE INDEX IF NOT EXISTS employee_skud_object_access_employee_active_idx
  ON public.employee_skud_object_access(employee_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS employee_skud_object_access_object_active_idx
  ON public.employee_skud_object_access(skud_object_id)
  WHERE is_active = true;

COMMIT;
