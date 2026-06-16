-- 183: догон к миграции 182 — бэкфилл руководителя в снимок СОГЛАСОВАННЫХ (approved)
-- персональных подач табеля за 01–15 июня 2026, где его нет.
--
-- Контекст: resolvePersonalSubmissionContext собирал состав персональной подачи
-- «по людям» только из прямых подчинённых, без самого руководителя. Миграция 182
-- закрыла этот дефект для status='submitted', но уже согласованные (approved)
-- подачи остались без руководителя в снимке. На момент подготовки — 1 строка
-- (Шадров С.И., approval 518, 12 подчинённых). Майские approved в скоуп НЕ входят
-- (решение: только июнь 01–15).
--
-- Снимок timesheet_approval_employees не читают экспорт-1С/зарплата — правка
-- approved безопасна (влияет только на карточку согласования HR и дедуп персональных
-- подач). Статус подачи не меняется.
--
-- Идемпотентно: NOT EXISTS + ON CONFLICT DO NOTHING делают повторный прогон no-op.

INSERT INTO public.timesheet_approval_employees (approval_id, employee_id, full_name)
SELECT a.id, a.manager_employee_id, e.full_name
  FROM public.timesheet_approvals a
  JOIN public.employees e ON e.id = a.manager_employee_id
 WHERE a.manager_employee_id IS NOT NULL
   AND a.status = 'approved'
   AND a.start_date = DATE '2026-06-01'
   AND a.end_date   = DATE '2026-06-15'
   AND NOT EXISTS (
     SELECT 1 FROM public.timesheet_approval_employees s
      WHERE s.approval_id = a.id AND s.employee_id = a.manager_employee_id
   )
ON CONFLICT (approval_id, employee_id) DO NOTHING;
