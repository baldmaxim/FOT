-- 268. Разовая чистка дублей в снимках персональных подач табеля.
--
-- Контекст. До введения правила «табель ведёт руководитель отдела» сотрудник мог
-- одновременно попасть в персональную подачу своего личного руководителя
-- (employee_direct_reports) и в подачу отдела. Код теперь такие дубли не создаёт,
-- но уже сохранённые снимки он не чинит.
--
-- Что удаляем: строку сотрудника из НЕзавершённой персональной подачи, если
--   1) тот же сотрудник есть в пересекающейся по датам подаче отдела, и
--   2) его членство в этом отделе покрывает ВЕСЬ диапазон персональной подачи.
--
-- Условие (2) обязательно: при переводе внутри полупериода пересечение законно —
-- часть дней ведёт старый отдел, часть личный руководитель, — и удаление строки
-- потеряло бы непокрытые дни.
--
-- Чего НЕ трогаем:
--   * персональные подачи со статусом approved — это официальная редакция табеля
--     для 1С, переписывать её задним числом нельзя;
--   * строку самого руководителя (employee_id = manager_employee_id);
--   * последнюю строку снимка — пустой ростер валит материализацию версии
--     (TimesheetVersionEmptyRosterError).
--
-- Миграция идемпотентна: повторный прогон не находит уже удалённых строк.

BEGIN;

WITH candidate AS (
  SELECT pe.approval_id,
         pe.employee_id,
         p.start_date,
         p.end_date,
         p.manager_employee_id
    FROM timesheet_approval_employees pe
    JOIN timesheet_approvals p ON p.id = pe.approval_id
   WHERE p.manager_employee_id IS NOT NULL
     AND p.status IN ('draft', 'submitted', 'returned', 'rejected')
     AND pe.employee_id <> p.manager_employee_id
),
-- Подача отдела, пересекающаяся по датам и содержащая того же сотрудника.
overlapping AS (
  SELECT c.approval_id,
         c.employee_id,
         c.start_date,
         c.end_date,
         d.department_id
    FROM candidate c
    JOIN timesheet_approvals d
      ON d.manager_employee_id IS NULL
     AND d.status IN ('submitted', 'approved', 'returned')
     AND daterange(d.start_date, d.end_date, '[]') && daterange(c.start_date, c.end_date, '[]')
    JOIN timesheet_approval_employees de
      ON de.approval_id = d.id AND de.employee_id = c.employee_id
),
-- Членство покрывает весь диапазон персональной подачи: либо открытое/закрывающее
-- назначение на этот отдел (или его потомка), либо отдел из snapshot совпадает.
fully_covered AS (
  SELECT DISTINCT o.approval_id, o.employee_id
    FROM overlapping o
   WHERE EXISTS (
           SELECT 1
             FROM employee_assignments ea
            WHERE ea.employee_id = o.employee_id
              AND ea.org_department_id = o.department_id
              AND ea.effective_from <= o.start_date
              AND (ea.effective_to IS NULL OR ea.effective_to >= o.end_date)
         )
      OR EXISTS (
           SELECT 1
             FROM employees e
            WHERE e.id = o.employee_id
              AND e.org_department_id = o.department_id
              -- snapshot авторитетен только когда истории назначений на период нет
              AND NOT EXISTS (
                    SELECT 1 FROM employee_assignments ea2
                     WHERE ea2.employee_id = o.employee_id
                       AND ea2.effective_from <= o.end_date
                       AND (ea2.effective_to IS NULL OR ea2.effective_to >= o.start_date)
                  )
         )
),
-- Защита от пустого ростера: сколько строк останется в снимке после удаления.
survivors AS (
  SELECT pe.approval_id, count(*) AS total
    FROM timesheet_approval_employees pe
   GROUP BY pe.approval_id
)
DELETE FROM timesheet_approval_employees victim
 USING fully_covered fc, survivors s
 WHERE victim.approval_id = fc.approval_id
   AND victim.employee_id = fc.employee_id
   AND s.approval_id = victim.approval_id
   AND s.total > (
         SELECT count(*) FROM fully_covered fc2 WHERE fc2.approval_id = victim.approval_id
       );

COMMIT;
