/**
 * «Признак» сотрудника — Работает / Уволен / Декрет. Единое правило для таблицы
 * «Управление кадрами» и Excel-выгрузки сотрудников, чтобы они не расходились.
 *
 * Декрет — активный сотрудник, чей отдел или любой предок называется «Декрет».
 * Уволенный — всегда «Уволен», даже если сидел в «Декрете».
 */

export type EmployeeSign = 'Работает' | 'Уволен' | 'Декрет';

export const MATERNITY_DEPARTMENT_NAME = 'декрет';

export interface ISignDepartment {
  id: string;
  parent_id: string | null;
  name: string | null;
}

export const normalizeDepartmentName = (name: string | null | undefined): string =>
  (name ?? '').trim().toLowerCase();

/** Отдел или его предок — «Декрет». Цикл parent_id не вешает подъём. */
export function isInMaternityDepartment(
  departmentId: string | null | undefined,
  deptById: ReadonlyMap<string, ISignDepartment>,
): boolean {
  const seen = new Set<string>();
  let current = departmentId ? deptById.get(departmentId) : undefined;
  while (current && !seen.has(current.id)) {
    if (normalizeDepartmentName(current.name) === MATERNITY_DEPARTMENT_NAME) return true;
    seen.add(current.id);
    current = current.parent_id ? deptById.get(current.parent_id) : undefined;
  }
  return false;
}

export function resolveEmployeeSign(params: {
  employmentStatus: string | null | undefined;
  departmentId: string | null | undefined;
  deptById: ReadonlyMap<string, ISignDepartment>;
}): EmployeeSign {
  if (params.employmentStatus === 'fired') return 'Уволен';
  return isInMaternityDepartment(params.departmentId, params.deptById) ? 'Декрет' : 'Работает';
}

export function buildSignDepartmentIndex(
  departments: readonly ISignDepartment[],
): Map<string, ISignDepartment> {
  const map = new Map<string, ISignDepartment>();
  for (const dept of departments) map.set(dept.id, dept);
  return map;
}
