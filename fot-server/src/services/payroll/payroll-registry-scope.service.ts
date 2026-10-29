/**
 * «Штат зарплаты» — кого видно в списке условий оплаты и в таблицах окна «Справочник»
 * («Доплата за проживание», «Доплата», «Без проезда», «Удержания»): работает, не в архиве,
 * не в ветке подрядных организаций, отдел — в охвате пользователя.
 *
 * Одни и те же фрагменты SQL у списка, у таблиц и у проверки перед записью: в таблицу нельзя
 * записать того, кого в ней не видно (например, подрядчика по прямому запросу).
 */
import * as Sentry from '@sentry/node';

import type { AuthenticatedRequest } from '../../types/index.js';
import { queryOne } from '../../config/postgres.js';
import { getContractorRootId } from '../../config/contractor.js';
import { canEditPayrollEmployee, resolvePayrollReadableDepartmentIds } from './payroll-scope.service.js';

/** CTE contractor_depts — поддерево подрядных организаций; параметр — id корня (NULL — не найден). */
export const payrollContractorDeptsCte = (rootParam: string): string => `contractor_depts AS (
    SELECT id FROM public.get_descendant_department_ids(ARRAY[${rootParam}::uuid])
     WHERE ${rootParam}::uuid IS NOT NULL
  )`;

/**
 * Условие «штата зарплаты» для сотрудника alias (нужен CTE contractor_depts). Подрядчики — через
 * NOT EXISTS, а не NOT IN: у сотрудника без отдела `NULL IN (...)` дал бы NULL, и он молча выпал бы.
 * departmentsParam — uuid[] охвата, NULL — весь штат.
 */
export const payrollStaffWhereSql = (alias: string, departmentsParam: string): string => (
  `${alias}.employment_status = 'active'
       AND ${alias}.is_archived IS NOT TRUE
       AND NOT EXISTS (SELECT 1 FROM contractor_depts c WHERE c.id = ${alias}.org_department_id)
       AND (${departmentsParam}::uuid[] IS NULL OR ${alias}.org_department_id = ANY(${departmentsParam}::uuid[]))`
);

/**
 * «Расчёты» за месяцы: сотрудник (employeeIdSql) работал хотя бы в одном из месяцев monthsParam (date[] первых чисел;
 * решение пользователя 28.10.2026 — уволенный на весь месяц и принятый позже месяца в нём не показываются). Работал в
 * месяце — принят не позже его конца и числился в не архивном отделе (archiveParam — uuid отдела «Уволенные», NULL —
 * не найден) по одному из источников состава табеля отдела (listEmployeeMembershipsForDepartmentPeriod): назначение,
 * пересекающее месяц; текущий отдел карточки, если в него не перевели встык из другого отдела после месяца; увольнение
 * из отдела с датой не раньше месяца. По одному назначению «Уволенные» не судим: у части работающих оно не закрыто,
 * а отдел карточки и СКУД рабочие (Ботирова, Аллазова, 2026). Карточка без отдела не скрывается: признака «не работал»
 * нет (на проде 28.10 таких 0).
 */
export const payrollWorkedInMonthsSql = (employeeIdSql: string, monthsParam: string, archiveParam: string): string => `EXISTS (
         SELECT 1
           FROM employees ew
          CROSS JOIN unnest(${monthsParam}::date[]) AS wm(month_start)
          CROSS JOIN LATERAL (SELECT (wm.month_start + INTERVAL '1 month - 1 day')::date AS month_end) we
          WHERE ew.id = ${employeeIdSql}
            AND (ew.hire_date IS NULL OR ew.hire_date <= we.month_end)
            AND (
              EXISTS (SELECT 1 FROM employee_assignments wa
                       WHERE wa.employee_id = ew.id
                         AND wa.org_department_id IS NOT NULL
                         AND wa.org_department_id IS DISTINCT FROM ${archiveParam}::uuid
                         AND wa.effective_from <= we.month_end
                         AND (wa.effective_to IS NULL OR wa.effective_to >= wm.month_start))
              OR ((ew.org_department_id IS NULL OR ew.org_department_id IS DISTINCT FROM ${archiveParam}::uuid)
                  AND NOT EXISTS (SELECT 1 FROM employee_assignments cur
                                    JOIN employee_assignments prev
                                      ON prev.employee_id = cur.employee_id
                                     AND prev.effective_to = cur.effective_from - 1
                                     AND prev.org_department_id IS DISTINCT FROM ew.org_department_id
                                   WHERE cur.employee_id = ew.id
                                     AND cur.org_department_id = ew.org_department_id
                                     AND cur.effective_from > we.month_end))
              OR EXISTS (SELECT 1 FROM employee_dismissal_events wd
                          WHERE wd.employee_id = ew.id
                            AND wd.cancelled = false
                            AND wd.dismissal_date >= wm.month_start
                            AND wd.from_department_id IS NOT NULL
                            AND wd.from_department_id IS DISTINCT FROM ${archiveParam}::uuid)
            )
       )`;

/**
 * Отдел «Уволенные» для payrollWorkedInMonthsSql. Нет в БД — null: архивных назначений тогда нет и правило верно.
 * Ошибка поиска — тоже null (остаётся правило даты приёма), но с предупреждением в лог и Sentry: экран не падает.
 */
export const resolvePayrollArchiveDepartmentId = async (): Promise<string | null> => {
  try {
    // Динамически: сервис архива тянет Sigur-модули (как в resolveTransferSegmentsInPeriod).
    const { getKnownArchiveDepartment } = await import('../employee-archive-department.service.js');
    return (await getKnownArchiveDepartment())?.id ?? null;
  } catch (error) {
    console.warn('[payroll-worked-months] отдел «Уволенные» не определён, «Расчёты» — только по дате приёма:', error);
    Sentry.captureException(error, { tags: { area: 'payroll-worked-months' } });
    return null;
  }
};

/** Параметры охвата для таблиц «Справочника»: корень подрядчиков и отделы (null — весь штат). */
export const resolvePayrollStaffScope = async (
  req: AuthenticatedRequest,
): Promise<{ contractorRootId: string | null; departmentIds: string[] | null }> => {
  const [departments, contractorRootId] = await Promise.all([
    resolvePayrollReadableDepartmentIds(req),
    getContractorRootId(),
  ]);
  return { contractorRootId, departmentIds: departments === 'all' ? null : departments };
};

/** Входит ли сотрудник в «штат зарплаты» с данным охватом. */
export const isPayrollStaffEmployee = async (
  employeeId: number,
  scope: { contractorRootId: string | null; departmentIds: string[] | null },
): Promise<boolean> => {
  const row = await queryOne<{ ok: boolean }>(
    `WITH ${payrollContractorDeptsCte('$2')}
     SELECT EXISTS (
       SELECT 1 FROM employees e WHERE e.id = $1 AND ${payrollStaffWhereSql('e', '$3')}
     ) AS ok`,
    [employeeId, scope.contractorRootId, scope.departmentIds],
  );
  return row?.ok === true;
};

/**
 * Можно ли записывать в таблицы «Справочника» по этому сотруднику: право на его условия оплаты
 * (canEditPayrollEmployee) и он в «штате зарплаты» — как строки, которые таблица показывает.
 */
export const canWritePayrollRegistryEmployee = async (
  req: AuthenticatedRequest,
  employeeId: number,
): Promise<boolean> => {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return false;
  if (!(await canEditPayrollEmployee(req, employeeId))) return false;
  return isPayrollStaffEmployee(employeeId, await resolvePayrollStaffScope(req));
};
