/**
 * «Штат зарплаты» — кого видно в списке условий оплаты и в таблицах окна «Справочник»
 * («Доплата за проживание», «Доплата», «Без проезда», «Удержания»): работает, не в архиве,
 * не в ветке подрядных организаций, отдел — в охвате пользователя.
 *
 * Одни и те же фрагменты SQL у списка, у таблиц и у проверки перед записью: в таблицу нельзя
 * записать того, кого в ней не видно (например, подрядчика по прямому запросу).
 */
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
