/**
 * «Признак» сотрудника — Работает / Уволен / Неактивен. Единое правило для таблицы
 * «Управление кадрами» и Excel-выгрузки сотрудников, чтобы они не расходились.
 *
 * Неактивен (миграция 381, решение 26.11.2026) — не уволенный сотрудник, который не работает:
 *  - ручная метка «Перевести в неактивные» (employees.staff_inactive_at);
 *  - отдел или любой его предок называется «Декрет» или «Архив» (папки Sigur СУ-10).
 * Уволенный — всегда «Уволен», даже если сидел в «Декрете».
 *
 * ВНИМАНИЕ: правило по названию отдела закрывает вход на портал (account-status.service). Новый отдел
 * «Архив» или «Декрет» в любой ветке сделает неактивными всех его сотрудников и их учётки.
 */

export type EmployeeSign = 'Работает' | 'Уволен' | 'Неактивен';

/** Название ветки, делающей сотрудника неактивным, — как его показывает интерфейс. */
export type AutoInactiveDepartmentName = 'Декрет' | 'Архив';

/** Нормализованное имя отдела → название ветки. */
export const AUTO_INACTIVE_DEPARTMENT_NAMES: ReadonlyMap<string, AutoInactiveDepartmentName> = new Map([
  ['декрет', 'Декрет'],
  ['архив', 'Архив'],
]);

export interface ISignDepartment {
  id: string;
  parent_id: string | null;
  name: string | null;
}

export const normalizeDepartmentName = (name: string | null | undefined): string =>
  (name ?? '').trim().toLowerCase();

/**
 * Ближайший к отделу узел «Декрет»/«Архив» (сам отдел или предок) — его название, иначе null.
 * Цикл parent_id не вешает подъём.
 */
export function findAutoInactiveDepartmentName(
  departmentId: string | null | undefined,
  deptById: ReadonlyMap<string, ISignDepartment>,
): AutoInactiveDepartmentName | null {
  const seen = new Set<string>();
  let current = departmentId ? deptById.get(departmentId) : undefined;
  while (current && !seen.has(current.id)) {
    const name = AUTO_INACTIVE_DEPARTMENT_NAMES.get(normalizeDepartmentName(current.name));
    if (name) return name;
    seen.add(current.id);
    current = current.parent_id ? deptById.get(current.parent_id) : undefined;
  }
  return null;
}

export function resolveEmployeeSign(params: {
  employmentStatus: string | null | undefined;
  departmentId: string | null | undefined;
  deptById: ReadonlyMap<string, ISignDepartment>;
  /** Ручная метка «Неактивный» (null/undefined — нет). */
  staffInactiveAt: string | Date | null | undefined;
}): EmployeeSign {
  if (params.employmentStatus === 'fired') return 'Уволен';
  if (params.staffInactiveAt) return 'Неактивен';
  return findAutoInactiveDepartmentName(params.departmentId, params.deptById) ? 'Неактивен' : 'Работает';
}

export function buildSignDepartmentIndex(
  departments: readonly ISignDepartment[],
): Map<string, ISignDepartment> {
  const map = new Map<string, ISignDepartment>();
  for (const dept of departments) map.set(dept.id, dept);
  return map;
}
