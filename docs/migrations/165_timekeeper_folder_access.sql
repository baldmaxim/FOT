-- 165: Папки (отделы оргструктуры) для скоупа табельщицы.
-- Видимые табельщице участки/бригады = пересечение «присутствуют на её объектах»
-- (через employee_skud_object_access) и «входят в выбранные папки» (этой таблицы,
-- с раскрытием поддерева). Пустой набор папок = табельщица не видит никого (строго).
-- Читается только timekeeper-scope.service.ts. Применять вручную.

CREATE TABLE IF NOT EXISTS public.timekeeper_folder_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timekeeper_user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timekeeper_folder_access_unique UNIQUE (timekeeper_user_id, department_id)
);
CREATE INDEX IF NOT EXISTS timekeeper_folder_access_tk_active_idx
  ON public.timekeeper_folder_access(timekeeper_user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS timekeeper_folder_access_dept_active_idx
  ON public.timekeeper_folder_access(department_id) WHERE is_active = true;

NOTIFY pgrst, 'reload schema';
