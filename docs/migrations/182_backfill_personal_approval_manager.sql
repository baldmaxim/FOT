-- 182: бэкфилл состава персональной подачи табеля — добавить самого руководителя
-- в снимок (timesheet_approval_employees), если его там нет.
--
-- Контекст: resolvePersonalSubmissionContext (fot-server) при персональной подаче
-- «по людям» собирал состав снимка только из прямых подчинённых, без самого
-- руководителя. Из-за этого проверяющий (HR) не видел руководителя — снимок есть
-- ровно то, по чему страница согласования тянет табель (employee_ids). Код
-- исправлен going-forward; эта миграция чинит уже поданные снимки, ждущие проверки.
--
-- Скоуп (узкий, по согласованию): только подачи в статусе 'submitted' за период
-- 01–15 июня 2026 (start_date=2026-06-01, end_date=2026-06-15), где руководителя
-- нет в снимке. Черновики/отклонённые пересоберутся при переподаче (код-фикс),
-- утверждённые/закрытые не трогаем. На момент подготовки — 1 строка (Галкин С.С.,
-- approval 475). Снимок не читают экспорт-1С/зарплата — правка безопасна.
--
-- Идемпотентно: NOT EXISTS + ON CONFLICT DO NOTHING делают повторный прогон no-op;
-- статус подачи не меняется.

INSERT INTO public.timesheet_approval_employees (approval_id, employee_id, full_name)
SELECT a.id, a.manager_employee_id, e.full_name
  FROM public.timesheet_approvals a
  JOIN public.employees e ON e.id = a.manager_employee_id
 WHERE a.manager_employee_id IS NOT NULL
   AND a.status = 'submitted'
   AND a.start_date = DATE '2026-06-01'
   AND a.end_date   = DATE '2026-06-15'
   AND NOT EXISTS (
     SELECT 1 FROM public.timesheet_approval_employees s
      WHERE s.approval_id = a.id AND s.employee_id = a.manager_employee_id
   )
ON CONFLICT (approval_id, employee_id) DO NOTHING;
