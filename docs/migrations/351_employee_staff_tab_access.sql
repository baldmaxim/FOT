-- 351_employee_staff_tab_access.sql
-- Вкладки «Проживание» и «Удержания» в «Система → Назначения сотрудников»: персональная галочка
-- открывает сотруднику правку вкладки «Управления кадрами» по всей организации, не меняя его роль.
-- Пример: комендант ведёт проживание, бухгалтер вносит удержания — без роли кадрового админа.
--
-- Две галочки независимы: строка на пару (сотрудник, вкладка). Выдают админ и кадровый админ
-- (ролевая правка вкладки + охват «вся организация», гард на маршруте). Снятие — удаление строки,
-- история — в audit_logs (EMPLOYEE_STAFF_TAB_ACCESS_CHANGED).
--
-- Увольнение снимает галочки вместе с отделами и пишет снимок в employee_lifecycle_revocations
-- (миграция 269, kind = 'staff_tab_access'); «Восстановить» возвращает их из снимка.
--
-- created_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285,
-- стережёт npm run audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_staff_tab_access (
  employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  tab text NOT NULL CHECK (tab IN ('dormitory', 'deductions')),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, tab)
);

COMMENT ON TABLE public.employee_staff_tab_access IS
  'Персональная правка вкладок «Управления кадрами» по всей организации: dormitory — «Проживание», deductions — «Удержания» (вкладки в назначениях).';

-- Снимок увольнения принимает и эти галочки.
ALTER TABLE public.employee_lifecycle_revocations
  DROP CONSTRAINT IF EXISTS employee_lifecycle_revocations_kind_check;
ALTER TABLE public.employee_lifecycle_revocations
  ADD CONSTRAINT employee_lifecycle_revocations_kind_check
  CHECK (kind IN ('department_access', 'direct_report', 'staff_tab_access'));

COMMIT;
