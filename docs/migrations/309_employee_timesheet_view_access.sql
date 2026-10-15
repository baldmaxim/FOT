-- 309_employee_timesheet_view_access.sql
-- «Просмотр табеля» — вкладка в «Система → Назначения сотрудников»: кому чей табель
-- доступен ТОЛЬКО на просмотр. Пример: руководителю строительства открыть табели людей
-- объекта, не делая их его прямыми подчинёнными.
--
-- Отдельно от employee_direct_reports («Человек») намеренно: прямой подчинённый — это
-- подача табеля, согласование заявлений и выходных, у сотрудника он один, а смена
-- руководителя посреди полумесяца кладёт человека в две подачи. Здесь ничего этого нет:
-- связь даёт только просмотр (грид, окно дня, поиск «По сотруднику»), смотрящих у одного
-- сотрудника сколько угодно. Подачи, согласования и выгрузки эту таблицу не читают.
--
-- Ключ — employee_id с обеих сторон, как у всех назначений: работает и для человека
-- без аккаунта. Снятие — удаление строки; история — в audit_logs
-- (EMPLOYEE_TIMESHEET_VIEW_ACCESS_CHANGED).
--
-- created_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285,
-- стережёт npm run audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_timesheet_view_access (
  viewer_employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_employee_id, employee_id),
  CONSTRAINT employee_timesheet_view_access_no_self CHECK (viewer_employee_id <> employee_id)
);

CREATE INDEX IF NOT EXISTS employee_timesheet_view_access_employee_idx
  ON public.employee_timesheet_view_access (employee_id);

COMMENT ON TABLE public.employee_timesheet_view_access IS
  'Просмотр табеля: viewer_employee_id видит табель employee_id только на чтение (вкладка «Просмотр табеля»).';

COMMIT;
