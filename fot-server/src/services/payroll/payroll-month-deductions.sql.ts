/**
 * Удержания месяца — одно правило для всех расчётов (миграции 318, 321, 357): помесячные (staff_deductions) и
 * плановые (payroll_planned_deductions), развёрнутые по месяцам. Через loadPayoutExtras и loadSummaryExtras его
 * получают «Расчёты», «Свод», «Выплачено», карточка, ЛК и табель «Зарплата»; таблицы «Удержания» показывают
 * плановые по месяцам тем же plannedDeductionMonthsSql — цифры совпадают везде.
 *
 * Плановое удерживается в месяце целиком (решение пользователя 10.11.2026: вся сумма, без учёта дней), если период
 * задевает месяц, сотрудник принят не позже конца месяца и работает или уволен не раньше 1-го числа месяца (как у
 * помесячных: уволенному — не позже месяца увольнения). В последнем месяце периода (month_to) — своя сумма, если
 * задана (last_month_amount, миграция 362).
 */

/**
 * Плановые удержания по месяцам: (planned_id, employee_id, month — date 1-го числа, kind_id, amount — сумма этого
 * месяца). monthsParam — date[] первых чисел; employeeIdsParam — int[] или NULL (все).
 */
export const plannedDeductionMonthsSql = (monthsParam: string, employeeIdsParam: string): string => `
  SELECT p.id AS planned_id, p.employee_id, pm.month, p.kind_id,
         COALESCE(CASE WHEN pm.month = p.month_to THEN p.last_month_amount END, p.amount) AS amount
    FROM payroll_planned_deductions p
    JOIN employees pe ON pe.id = p.employee_id
   CROSS JOIN unnest(${monthsParam}::date[]) AS pm(month)
   WHERE p.month_from <= pm.month
     AND (p.month_to IS NULL OR p.month_to >= pm.month)
     AND (${employeeIdsParam}::int[] IS NULL OR p.employee_id = ANY(${employeeIdsParam}::int[]))
     AND (pe.hire_date IS NULL OR pe.hire_date <= (pm.month + INTERVAL '1 month - 1 day')::date)
     AND (pe.employment_status = 'active'
          OR (pe.employment_status = 'fired' AND pe.dismissal_date >= pm.month))`;

/**
 * Все удержания месяцев: (employee_id, month, kind_id, amount) — помесячные и плановые одной выборкой; суммируют
 * по виду вызывающие.
 */
export const monthDeductionsSql = (monthsParam: string, employeeIdsParam: string): string => `
  SELECT s.employee_id, s.month, s.kind_id, s.amount
    FROM staff_deductions s
   WHERE s.month = ANY(${monthsParam}::date[])
     AND (${employeeIdsParam}::int[] IS NULL OR s.employee_id = ANY(${employeeIdsParam}::int[]))
  UNION ALL
  SELECT planned.employee_id, planned.month, planned.kind_id, planned.amount
    FROM (${plannedDeductionMonthsSql(monthsParam, employeeIdsParam)}) planned`;
