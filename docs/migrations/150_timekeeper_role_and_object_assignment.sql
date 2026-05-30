-- 150_timekeeper_role_and_object_assignment.sql
--
-- Роль «Табельщица» (timekeeper) + ручное назначение «объектов входа» (skud_objects)
-- сущностям для скоупа табельщицы.
--
-- Модель: табельщице назначаются объекты (timekeeper_object_access). Её зона доступа =
--   отделы/бригады, назначенные этим объектам (department_object_assignment) + их сотрудники,
--   плюс сотрудники, назначенные объектам явно (employee_object_assignment, для мультиобъектных).
--
-- ВАЖНО: эти таблицы развязаны с учётом объекта в 1С (Единый файл по Sigur-пробивам) и с
--   employee_skud_object_access (/skud-presence). Их читает ТОЛЬКО скоуп табельщицы.
--
-- Права роли = полный менеджерский доступ (correction-ограничения выключены), видит фактические
--   часы. Доступна только страница «Табель» (/timesheet).
--
-- Применяется вручную через psql на проде (авто-миграций нет). Идемпотентно.

BEGIN;

-- 1) Роль timekeeper.
INSERT INTO public.system_roles (
  code, name, description,
  is_admin, employee_variant, show_actual_hours,
  hide_sidebar,
  timesheet_months_back, timesheet_months_forward, timesheet_show_full_period,
  weekend_memo_required,
  corrections_anomalies_only,
  corrections_cap_by_schedule_norm,
  corrections_allow_zero_short_attendance,
  corrections_disable_bulk,
  max_corrections_per_month,
  is_active
)
VALUES (
  'timekeeper',
  'Табельщица',
  'Ведёт табель сотрудников назначенных объектов входа. Полный доступ к корректировкам (как менеджер), видит фактические часы. Доступна только страница «Табель».',
  false,   -- is_admin
  NULL,    -- employee_variant (не вариант ЛК сотрудника)
  true,    -- show_actual_hours — видит фактические часы
  false,   -- hide_sidebar
  3, 1, true,   -- окно табеля: 3 мес назад, 1 вперёд, кнопка «весь период»
  false,   -- weekend_memo_required
  false,   -- corrections_anomalies_only
  false,   -- corrections_cap_by_schedule_norm
  false,   -- corrections_allow_zero_short_attendance
  false,   -- corrections_disable_bulk
  NULL,    -- max_corrections_per_month — без лимита
  true
)
ON CONFLICT (code) DO NOTHING;

-- 2) Доступ только к странице «Табель».
INSERT INTO public.role_page_access (role_code, page_path, can_view, can_edit)
VALUES ('timekeeper', '/timesheet', true, true)
ON CONFLICT (role_code, page_path) DO NOTHING;

-- 3) Отдел/бригада → объект (члены наследуют динамически). M:N.
CREATE TABLE IF NOT EXISTS public.department_object_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  skud_object_id uuid NOT NULL REFERENCES public.skud_objects(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT department_object_assignment_unique UNIQUE (org_department_id, skud_object_id)
);
CREATE INDEX IF NOT EXISTS department_object_assignment_dept_active_idx
  ON public.department_object_assignment(org_department_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS department_object_assignment_object_active_idx
  ON public.department_object_assignment(skud_object_id) WHERE is_active = true;

-- 4) Сотрудник → объект (переопределение/добавление для мультиобъектных). M:N.
CREATE TABLE IF NOT EXISTS public.employee_object_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  skud_object_id uuid NOT NULL REFERENCES public.skud_objects(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_object_assignment_unique UNIQUE (employee_id, skud_object_id)
);
CREATE INDEX IF NOT EXISTS employee_object_assignment_emp_active_idx
  ON public.employee_object_assignment(employee_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS employee_object_assignment_object_active_idx
  ON public.employee_object_assignment(skud_object_id) WHERE is_active = true;

-- 5) Табельщица → объекты. M:N.
CREATE TABLE IF NOT EXISTS public.timekeeper_object_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timekeeper_user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  skud_object_id uuid NOT NULL REFERENCES public.skud_objects(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timekeeper_object_access_unique UNIQUE (timekeeper_user_id, skud_object_id)
);
CREATE INDEX IF NOT EXISTS timekeeper_object_access_tk_active_idx
  ON public.timekeeper_object_access(timekeeper_user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS timekeeper_object_access_object_active_idx
  ON public.timekeeper_object_access(skud_object_id) WHERE is_active = true;

NOTIFY pgrst, 'reload schema';

COMMIT;
